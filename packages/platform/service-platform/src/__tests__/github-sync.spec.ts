import type { GithubApi } from '@bangle.io/github-api';
import { describe, expect, test } from 'vitest';
import { conflictPathFor, type SyncFs, syncWorkspace } from '../github-sync';
import { emptySyncState, type WorkspaceSyncState } from '../github-sync-store';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const NOW = new Date('2026-09-21T08:00:00.000Z');
const CONFLICT_STAMP = '2026-09-21T08-00-00-000';

/** In-memory stand-in for the branch, addressed the way git actually is. */
class FakeRemote {
  public head = 'commit-0';
  private blobs = new Map<string, Uint8Array>();
  private tree = new Map<string, string>();
  private counter = 0;

  seed(path: string, content: string): string {
    const sha = `sha-${++this.counter}`;
    this.blobs.set(sha, encoder.encode(content));
    this.tree.set(path, sha);
    return sha;
  }

  contentAt(path: string): string | undefined {
    const sha = this.tree.get(path);
    const bytes = sha ? this.blobs.get(sha) : undefined;
    return bytes ? decoder.decode(bytes) : undefined;
  }

  paths(): string[] {
    return [...this.tree.keys()].sort();
  }

  asApi(): GithubApi {
    return {
      getHead: async () => ({ commitSha: this.head, treeSha: 'tree' }),
      listFiles: async () =>
        [...this.tree.entries()].map(([path, sha]) => ({
          path,
          sha,
          size: this.blobs.get(sha)?.length ?? 0,
        })),
      readBlob: async (sha: string) => {
        const blob = this.blobs.get(sha);
        if (!blob) throw new Error(`no blob ${sha}`);
        return blob;
      },
      commitChanges: async ({
        changes,
        expectedHeadSha,
      }: {
        changes: Array<
          | { type: 'write'; path: string; bytes: Uint8Array }
          | { type: 'delete'; path: string }
        >;
        expectedHeadSha: string;
      }) => {
        if (expectedHeadSha !== this.head) {
          throw new Error('conflict');
        }
        const writtenShas: Record<string, string> = {};
        for (const change of changes) {
          if (change.type === 'delete') {
            this.tree.delete(change.path);
            continue;
          }
          const sha = `sha-${++this.counter}`;
          this.blobs.set(sha, change.bytes);
          this.tree.set(change.path, sha);
          writtenShas[change.path] = sha;
        }
        this.head = `commit-${++this.counter}`;
        return { commitSha: this.head, treeSha: 'tree', writtenShas };
      },
    } as unknown as GithubApi;
  }
}

function makeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([k, v]) => [k, encoder.encode(v)]),
  );
  const fs: SyncFs = {
    listPaths: async () => [...files.keys()],
    read: async (_ws, path) => files.get(path),
    write: async (_ws, path, bytes) => {
      files.set(path, bytes);
    },
    remove: async (_ws, path) => {
      files.delete(path);
    },
  };
  return {
    fs,
    files,
    content: (path: string) => {
      const bytes = files.get(path);
      return bytes ? decoder.decode(bytes) : undefined;
    },
    paths: () => [...files.keys()].sort(),
  };
}

async function run(
  remote: FakeRemote,
  local: ReturnType<typeof makeFs>,
  state: WorkspaceSyncState,
) {
  return syncWorkspace({
    wsName: 'notes',
    api: remote.asApi(),
    fs: local.fs,
    state,
    now: NOW,
  });
}

describe('conflictPathFor', () => {
  test('keeps the extension so the copy is still an openable note', () => {
    expect(conflictPathFor('a/b/today.md', NOW)).toBe(
      `a/b/today.conflict-${CONFLICT_STAMP}.md`,
    );
  });

  test('handles a name with no extension', () => {
    expect(conflictPathFor('LICENSE', NOW)).toBe(
      `LICENSE.conflict-${CONFLICT_STAMP}`,
    );
  });

  test('does not treat a leading dot as an extension', () => {
    expect(conflictPathFor('.gitignore', NOW)).toBe(
      `.gitignore.conflict-${CONFLICT_STAMP}`,
    );
  });
});

describe('first sync', () => {
  test('pulls every remote note into an empty mirror', async () => {
    const remote = new FakeRemote();
    remote.seed('a.md', 'alpha');
    remote.seed('n/b.md', 'beta');
    const local = makeFs();

    const { result, state } = await run(remote, local, emptySyncState());

    expect(result.pulled.sort()).toEqual(['a.md', 'n/b.md']);
    expect(local.content('a.md')).toBe('alpha');
    expect(state.records['a.md']).toEqual({
      syncedSha: expect.any(String),
      dirty: false,
      deleted: false,
    });
  });

  test('pushes local-only notes and records the sha they landed at', async () => {
    const remote = new FakeRemote();
    const local = makeFs({ 'new.md': 'hello' });

    const { result, state } = await run(remote, local, emptySyncState());

    expect(result.pushed).toEqual(['new.md']);
    expect(remote.contentAt('new.md')).toBe('hello');
    expect(state.records['new.md']?.dirty).toBe(false);
    expect(state.records['new.md']?.syncedSha).toEqual(expect.any(String));
  });
});

describe('clean cases', () => {
  test('a remote-only edit is pulled', async () => {
    const remote = new FakeRemote();
    const sha = remote.seed('a.md', 'v1');
    const local = makeFs({ 'a.md': 'v1' });
    const state: WorkspaceSyncState = {
      records: { 'a.md': { syncedSha: sha, dirty: false, deleted: false } },
      lastHeadSha: 'commit-0',
      lastSyncedAt: 0,
    };

    remote.seed('a.md', 'v2');
    const { result } = await run(remote, local, state);

    expect(result.pulled).toEqual(['a.md']);
    expect(local.content('a.md')).toBe('v2');
    expect(result.conflicts).toEqual([]);
  });

  test('a local-only edit is pushed', async () => {
    const remote = new FakeRemote();
    const sha = remote.seed('a.md', 'v1');
    const local = makeFs({ 'a.md': 'local edit' });
    const state: WorkspaceSyncState = {
      records: { 'a.md': { syncedSha: sha, dirty: true, deleted: false } },
      lastHeadSha: 'commit-0',
      lastSyncedAt: 0,
    };

    const { result } = await run(remote, local, state);

    expect(result.pushed).toEqual(['a.md']);
    expect(remote.contentAt('a.md')).toBe('local edit');
    expect(result.conflicts).toEqual([]);
  });

  test('an untouched file moves nothing', async () => {
    const remote = new FakeRemote();
    const sha = remote.seed('a.md', 'v1');
    const local = makeFs({ 'a.md': 'v1' });
    const state: WorkspaceSyncState = {
      records: { 'a.md': { syncedSha: sha, dirty: false, deleted: false } },
      lastHeadSha: 'commit-0',
      lastSyncedAt: 0,
    };

    const { result } = await run(remote, local, state);

    expect(result.pulled).toEqual([]);
    expect(result.pushed).toEqual([]);
    expect(result.commitSha).toBeNull();
  });
});

describe('conflicts keep both sides', () => {
  test('both edited: remote keeps the path, local is parked and pushed', async () => {
    const remote = new FakeRemote();
    const base = remote.seed('a.md', 'base');
    const local = makeFs({ 'a.md': 'mine' });
    const state: WorkspaceSyncState = {
      records: { 'a.md': { syncedSha: base, dirty: true, deleted: false } },
      lastHeadSha: 'commit-0',
      lastSyncedAt: 0,
    };
    remote.seed('a.md', 'theirs');

    const { result, state: next } = await run(remote, local, state);

    const parked = `a.conflict-${CONFLICT_STAMP}.md`;
    expect(result.conflicts).toEqual([
      { path: 'a.md', conflictPath: parked, reason: 'both-edited' },
    ]);
    // Remote wins the canonical path, locally and remotely.
    expect(local.content('a.md')).toBe('theirs');
    expect(remote.contentAt('a.md')).toBe('theirs');
    // And nothing was lost: the local version exists on both sides.
    expect(local.content(parked)).toBe('mine');
    expect(remote.contentAt(parked)).toBe('mine');
    expect(next.records[parked]?.dirty).toBe(false);
  });

  test('both created the same path independently', async () => {
    const remote = new FakeRemote();
    remote.seed('a.md', 'theirs');
    const local = makeFs({ 'a.md': 'mine' });

    const { result } = await run(remote, local, emptySyncState());

    const parked = `a.conflict-${CONFLICT_STAMP}.md`;
    expect(result.conflicts[0]).toMatchObject({ reason: 'both-created' });
    expect(local.content('a.md')).toBe('theirs');
    expect(local.content(parked)).toBe('mine');
  });

  test('edited here, deleted upstream: the note is pushed back, not lost', async () => {
    const remote = new FakeRemote();
    const local = makeFs({ 'a.md': 'my edit' });
    const state: WorkspaceSyncState = {
      records: {
        'a.md': { syncedSha: 'sha-old', dirty: true, deleted: false },
      },
      lastHeadSha: 'commit-0',
      lastSyncedAt: 0,
    };

    const { result } = await run(remote, local, state);

    expect(result.conflicts[0]).toMatchObject({ reason: 'deleted-remotely' });
    expect(remote.contentAt('a.md')).toBe('my edit');
    expect(local.content('a.md')).toBe('my edit');
  });

  test('deleted here, edited upstream: the note is resurrected', async () => {
    const remote = new FakeRemote();
    remote.seed('a.md', 'their new edit');
    const local = makeFs();
    const state: WorkspaceSyncState = {
      records: {
        'a.md': { syncedSha: 'sha-old', dirty: false, deleted: true },
      },
      lastHeadSha: 'commit-0',
      lastSyncedAt: 0,
    };

    const { result } = await run(remote, local, state);

    expect(result.conflicts[0]).toMatchObject({ reason: 'deleted-locally' });
    expect(local.content('a.md')).toBe('their new edit');
    expect(remote.contentAt('a.md')).toBe('their new edit');
  });
});

describe('deletions', () => {
  test('a clean local copy of an upstream-deleted file is removed', async () => {
    const remote = new FakeRemote();
    const local = makeFs({ 'a.md': 'v1' });
    const state: WorkspaceSyncState = {
      records: {
        'a.md': { syncedSha: 'sha-old', dirty: false, deleted: false },
      },
      lastHeadSha: 'commit-0',
      lastSyncedAt: 0,
    };

    const { result, state: next } = await run(remote, local, state);

    expect(result.deletedLocally).toEqual(['a.md']);
    expect(local.paths()).toEqual([]);
    expect(next.records['a.md']).toBeUndefined();
  });

  test('a local delete propagates upstream', async () => {
    const remote = new FakeRemote();
    const sha = remote.seed('a.md', 'v1');
    const local = makeFs();
    const state: WorkspaceSyncState = {
      records: { 'a.md': { syncedSha: sha, dirty: false, deleted: true } },
      lastHeadSha: 'commit-0',
      lastSyncedAt: 0,
    };

    const { result } = await run(remote, local, state);

    expect(result.deletedRemotely).toEqual(['a.md']);
    expect(remote.paths()).toEqual([]);
  });

  test('recreating a deleted file voids its tombstone', async () => {
    const remote = new FakeRemote();
    const sha = remote.seed('a.md', 'v1');
    const local = makeFs({ 'a.md': 'recreated' });
    const state: WorkspaceSyncState = {
      records: { 'a.md': { syncedSha: sha, dirty: false, deleted: true } },
      lastHeadSha: 'commit-0',
      lastSyncedAt: 0,
    };

    const { result } = await run(remote, local, state);

    expect(result.deletedRemotely).toEqual([]);
    expect(remote.contentAt('a.md')).toBe('recreated');
  });

  test('a file gone from both sides just drops its tombstone', async () => {
    const remote = new FakeRemote();
    const local = makeFs();
    const state: WorkspaceSyncState = {
      records: {
        'a.md': { syncedSha: 'sha-old', dirty: false, deleted: true },
      },
      lastHeadSha: 'commit-0',
      lastSyncedAt: 0,
    };

    const { result, state: next } = await run(remote, local, state);

    expect(result.commitSha).toBeNull();
    expect(next.records['a.md']).toBeUndefined();
  });
});

describe('batching', () => {
  test('every change lands in a single commit', async () => {
    const remote = new FakeRemote();
    const keep = remote.seed('keep.md', 'v1');
    const drop = remote.seed('drop.md', 'v1');
    const local = makeFs({ 'keep.md': 'edited', 'new.md': 'new' });
    const state: WorkspaceSyncState = {
      records: {
        'keep.md': { syncedSha: keep, dirty: true, deleted: false },
        'drop.md': { syncedSha: drop, dirty: false, deleted: true },
      },
      lastHeadSha: 'commit-0',
      lastSyncedAt: 0,
    };

    const { result } = await run(remote, local, state);

    expect(result.commitSha).not.toBeNull();
    expect(result.pushed.sort()).toEqual(['keep.md', 'new.md']);
    expect(result.deletedRemotely).toEqual(['drop.md']);
    expect(remote.paths()).toEqual(['keep.md', 'new.md']);
  });

  test('two syncs in a row leave nothing to do the second time', async () => {
    const remote = new FakeRemote();
    remote.seed('a.md', 'alpha');
    const local = makeFs({ 'b.md': 'beta' });

    const first = await run(remote, local, emptySyncState());
    const second = await run(remote, local, first.state);

    expect(second.result.pulled).toEqual([]);
    expect(second.result.pushed).toEqual([]);
    expect(second.result.conflicts).toEqual([]);
    expect(second.result.commitSha).toBeNull();
  });
});

describe('path filtering', () => {
  const notDotted = (path: string): 'sync' | 'ignore' =>
    path.split('/').some((segment) => segment.startsWith('.'))
      ? 'ignore'
      : 'sync';

  async function runFiltered(
    remote: FakeRemote,
    local: ReturnType<typeof makeFs>,
    state: WorkspaceSyncState,
  ) {
    return syncWorkspace({
      wsName: 'notes',
      api: remote.asApi(),
      fs: local.fs,
      state,
      now: NOW,
      classifyPath: notDotted,
    });
  }

  test('ignored remote paths are never pulled', async () => {
    const remote = new FakeRemote();
    remote.seed('note.md', 'keep');
    remote.seed('.github/workflows/ci.yml', 'ci config');
    const local = makeFs();

    const { result } = await runFiltered(remote, local, emptySyncState());

    expect(result.pulled).toEqual(['note.md']);
    expect(local.paths()).toEqual(['note.md']);
  });

  test('ignored remote paths are left alone, not deleted', async () => {
    const remote = new FakeRemote();
    remote.seed('.github/workflows/ci.yml', 'ci config');
    const local = makeFs({ 'note.md': 'mine' });

    await runFiltered(remote, local, emptySyncState());

    // The workflow file must survive: the app never saw it, so it has no
    // business removing it.
    expect(remote.contentAt('.github/workflows/ci.yml')).toBe('ci config');
    expect(remote.contentAt('note.md')).toBe('mine');
  });

  test('ignored local paths are never pushed', async () => {
    const remote = new FakeRemote();
    const local = makeFs({ 'note.md': 'mine', '.hidden/x.md': 'secret' });

    const { result } = await runFiltered(remote, local, emptySyncState());

    expect(result.pushed).toEqual(['note.md']);
    expect(remote.paths()).toEqual(['note.md']);
  });
});

describe('paths the app cannot represent', () => {
  // Mirrors the real rule: workspace paths forbid < > : " \ | ? * and control
  // characters, all of which are legal on GitHub.
  const classify = (path: string): 'sync' | 'ignore' | 'unsupported' => {
    if (path.split('/').some((segment) => segment.startsWith('.'))) {
      return 'ignore';
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: mirrors the real path validator, which rejects control characters too
    return /[<>:"\\|?*\u0000-\u001F]/.test(path) ? 'unsupported' : 'sync';
  };

  async function runClassified(
    remote: FakeRemote,
    local: ReturnType<typeof makeFs>,
    state: WorkspaceSyncState,
  ) {
    return syncWorkspace({
      wsName: 'notes',
      api: remote.asApi(),
      fs: local.fs,
      state,
      now: NOW,
      classifyPath: classify,
    });
  }

  test('one unnameable file does not abort the whole sync', async () => {
    const remote = new FakeRemote();
    remote.seed('Notes/Does this quick Note move?.md', 'awkward');
    remote.seed('Notes/ordinary.md', 'fine');
    remote.seed('Notes/another.md', 'also fine');
    const local = makeFs();

    const { result } = await runClassified(remote, local, emptySyncState());

    // The other 2 still arrive — the real failure was all-or-nothing.
    expect(result.pulled.sort()).toEqual([
      'Notes/another.md',
      'Notes/ordinary.md',
    ]);
  });

  test('reports the skipped path instead of dropping it silently', async () => {
    const remote = new FakeRemote();
    remote.seed('Notes/Does this quick Note move?.md', 'awkward');
    remote.seed('Notes/ordinary.md', 'fine');
    const local = makeFs();

    const { result } = await runClassified(remote, local, emptySyncState());

    expect(result.skipped).toEqual(['Notes/Does this quick Note move?.md']);
  });

  test('leaves the unnameable file untouched on the remote', async () => {
    const remote = new FakeRemote();
    remote.seed('Notes/Does this quick Note move?.md', 'awkward');
    const local = makeFs();

    await runClassified(remote, local, emptySyncState());

    expect(remote.contentAt('Notes/Does this quick Note move?.md')).toBe(
      'awkward',
    );
    expect(local.paths()).toEqual([]);
  });

  test('ignored paths are not reported as skipped', async () => {
    const remote = new FakeRemote();
    remote.seed('.github/workflows/ci.yml', 'ci');
    remote.seed('note.md', 'fine');
    const local = makeFs();

    const { result } = await runClassified(remote, local, emptySyncState());

    // Ignoring CI config is intended; reporting it would be noise.
    expect(result.skipped).toEqual([]);
    expect(result.pulled).toEqual(['note.md']);
  });

  test('a path unnameable on both sides is reported once', async () => {
    const remote = new FakeRemote();
    remote.seed('bad?.md', 'remote');
    const local = makeFs({ 'bad?.md': 'local' });

    const { result } = await runClassified(remote, local, emptySyncState());

    expect(result.skipped).toEqual(['bad?.md']);
  });
});

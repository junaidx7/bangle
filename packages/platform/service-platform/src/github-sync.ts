import type {
  GithubApi,
  GithubChange,
  RemoteEntry,
} from '@bangle.io/github-api';
import type {
  FileStorageConflict,
  FileStorageSyncResult,
} from '@bangle.io/types';
import type { SyncRecord, WorkspaceSyncState } from './github-sync-store';

/**
 * The slice of a filesystem the sync engine needs. Kept narrow and
 * repo-relative so the engine can be tested against a plain Map.
 */
export interface SyncFs {
  listPaths: (wsName: string, signal?: AbortSignal) => Promise<string[]>;
  read: (wsName: string, path: string) => Promise<Uint8Array | undefined>;
  write: (wsName: string, path: string, bytes: Uint8Array) => Promise<void>;
  remove: (wsName: string, path: string) => Promise<void>;
}

/**
 * Shapes are pinned to the shared contract so the core file-system service can
 * report a sync without depending on this package.
 */
export type ConflictInfo = FileStorageConflict;
export type SyncResult = FileStorageSyncResult;

/**
 * Builds the sibling path a conflicting local version is parked at. Keeping
 * the original extension means the copy is still a note you can open and
 * reconcile in the editor, rather than an inert `.bak` the app ignores.
 */
export function conflictPathFor(path: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const base = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? '' : name.slice(dot);
  return `${dir}${base}.conflict-${stamp}${ext}`;
}

const UNTRACKED: SyncRecord = { syncedSha: null, dirty: true, deleted: false };

/**
 * Reads the stored record in light of what is actually on disk.
 *
 * Two corrections matter. A file with no record at all is a note the user just
 * made, so it counts as local-only and dirty. And a tombstone is void the
 * moment the file is back on disk: recreating it is the newer intent, so the
 * pending delete becomes a pending write instead.
 */
function resolveRecord(
  stored: SyncRecord | undefined,
  existsLocally: boolean,
): SyncRecord | undefined {
  if (!stored) {
    return existsLocally ? UNTRACKED : undefined;
  }
  if (stored.deleted && existsLocally) {
    return { syncedSha: stored.syncedSha, dirty: true, deleted: false };
  }
  return stored;
}

/**
 * Reconciles the local mirror with a branch, then pushes everything local in a
 * single commit.
 *
 * The guiding rule is that no edit is ever destroyed. Whenever both sides moved
 * the same file, the remote version takes the canonical path and the local one
 * is parked alongside it as a `.conflict-<timestamp>` note, which is itself
 * pushed — so the divergence ends up visible in the repo instead of resolved
 * behind the user's back.
 */
export async function syncWorkspace({
  wsName,
  api,
  fs,
  state,
  now = new Date(),
  signal,
  isSyncablePath = () => true,
}: {
  wsName: string;
  api: GithubApi;
  fs: SyncFs;
  state: WorkspaceSyncState;
  now?: Date;
  signal?: AbortSignal;
  /**
   * Decides which repo paths are workspace content. A notes repo is still a
   * git repo: without this, `.github/workflows`, `dist/`, and `node_modules`
   * would all be mirrored into the browser and listed as notes.
   *
   * Paths this rejects are inert — never pulled, never pushed, never deleted
   * on either side — so pointing at a repo that also holds code leaves that
   * code strictly alone.
   */
  isSyncablePath?: (repoPath: string) => boolean;
}): Promise<{ result: SyncResult; state: WorkspaceSyncState }> {
  const head = await api.getHead(signal);
  const remoteEntries = await api.listFiles(signal);
  const remote = new Map<string, RemoteEntry>(
    remoteEntries
      .filter((entry) => isSyncablePath(entry.path))
      .map((entry) => [entry.path, entry]),
  );
  const localPaths = new Set(
    (await fs.listPaths(wsName, signal)).filter((path) => isSyncablePath(path)),
  );

  const records = { ...state.records };
  const nextRecords: Record<string, SyncRecord> = {};

  const result: SyncResult = {
    pulled: [],
    pushed: [],
    deletedLocally: [],
    deletedRemotely: [],
    conflicts: [],
    commitSha: null,
    headSha: head.commitSha,
  };

  const changes: GithubChange[] = [];
  // Paths whose record can only be settled once we know the pushed blob sha.
  const pendingPush = new Set<string>();

  const queuePush = async (path: string) => {
    const bytes = await fs.read(wsName, path);
    if (bytes === undefined) {
      return;
    }
    changes.push({ type: 'write', path, bytes });
    pendingPush.add(path);
    result.pushed.push(path);
  };

  const pull = async (path: string, entry: RemoteEntry) => {
    const bytes = await api.readBlob(entry.sha, signal);
    await fs.write(wsName, path, bytes);
    nextRecords[path] = { syncedSha: entry.sha, dirty: false, deleted: false };
    result.pulled.push(path);
  };

  /** Parks the local version beside the remote one and schedules it for push. */
  const park = async (
    path: string,
    reason: ConflictInfo['reason'],
  ): Promise<string | undefined> => {
    const bytes = await fs.read(wsName, path);
    if (bytes === undefined) {
      return undefined;
    }
    const conflictPath = conflictPathFor(path, now);
    await fs.write(wsName, conflictPath, bytes);
    changes.push({ type: 'write', path: conflictPath, bytes });
    pendingPush.add(conflictPath);
    result.pushed.push(conflictPath);
    result.conflicts.push({ path, conflictPath, reason });
    return conflictPath;
  };

  const allPaths = new Set([...localPaths, ...remote.keys()]);

  for (const path of allPaths) {
    if (signal?.aborted) {
      throw new DOMException('Sync aborted', 'AbortError');
    }

    const entry = remote.get(path);
    const existsLocally = localPaths.has(path);
    const record = resolveRecord(records[path], existsLocally);

    if (record?.deleted && !existsLocally) {
      if (!entry) {
        // Already gone on both sides; drop the tombstone.
        continue;
      }
      if (entry.sha === record.syncedSha) {
        changes.push({ type: 'delete', path });
        result.deletedRemotely.push(path);
        continue;
      }
      // The remote changed after our delete. Resurrect rather than discard
      // someone else's edit.
      await pull(path, entry);
      result.conflicts.push({
        path,
        conflictPath: path,
        reason: 'deleted-locally',
      });
      continue;
    }

    if (!existsLocally && entry) {
      await pull(path, entry);
      continue;
    }

    if (existsLocally && !entry) {
      const local = record ?? UNTRACKED;
      if (local.syncedSha === null) {
        // Genuinely new local note.
        await queuePush(path);
        continue;
      }
      if (local.dirty) {
        // Deleted remotely but edited here: push it back rather than lose it.
        await queuePush(path);
        result.conflicts.push({
          path,
          conflictPath: path,
          reason: 'deleted-remotely',
        });
        continue;
      }
      // Clean copy of a file deleted upstream: honour the deletion.
      await fs.remove(wsName, path);
      result.deletedLocally.push(path);
      continue;
    }

    if (!existsLocally || !entry) {
      continue;
    }

    const local = record ?? UNTRACKED;
    const remoteMoved = entry.sha !== local.syncedSha;

    if (!local.dirty) {
      if (remoteMoved) {
        await pull(path, entry);
      } else {
        nextRecords[path] = local;
      }
      continue;
    }

    if (!remoteMoved) {
      await queuePush(path);
      continue;
    }

    // Both sides moved. Remote keeps the canonical path; local is parked.
    await park(path, local.syncedSha === null ? 'both-created' : 'both-edited');
    await pull(path, entry);
  }

  if (changes.length > 0) {
    const commit = await api.commitChanges(
      {
        changes,
        message: buildCommitMessage(result),
        expectedHeadSha: head.commitSha,
      },
      signal,
    );
    result.commitSha = commit.commitSha;
    result.headSha = commit.commitSha;

    for (const path of pendingPush) {
      const sha = commit.writtenShas[path];
      nextRecords[path] = {
        syncedSha: sha ?? null,
        // If GitHub somehow did not report a sha we keep the file dirty so the
        // next sync retries it rather than assuming it landed.
        dirty: sha === undefined,
        deleted: false,
      };
    }
  }

  return {
    result,
    state: {
      records: nextRecords,
      lastHeadSha: result.headSha,
      lastSyncedAt: now.getTime(),
    },
  };
}

function buildCommitMessage(result: SyncResult): string {
  const parts: string[] = [];
  if (result.pushed.length > 0) {
    parts.push(`update ${result.pushed.length}`);
  }
  if (result.deletedRemotely.length > 0) {
    parts.push(`delete ${result.deletedRemotely.length}`);
  }
  const summary = parts.join(', ') || 'sync';
  return `bangle: ${summary}`;
}

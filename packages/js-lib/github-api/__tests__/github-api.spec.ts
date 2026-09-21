import { describe, expect, test, vi } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '../base64';
import { GithubApiError } from '../errors';
import { GithubApi } from '../github-api';
import { parseRepoInput } from '../parse-repo-input';

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function makeApi(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init);
    },
  ) as unknown as typeof fetch;

  const api = new GithubApi({
    owner: 'octo',
    repo: 'notes',
    branch: 'main',
    token: 'tok',
    fetchImpl,
  });

  return { api, calls };
}

describe('base64', () => {
  test('round-trips non-ASCII content', () => {
    const text = 'héllo — 世界 🎉';
    const bytes = new TextEncoder().encode(text);
    const decoded = base64ToBytes(bytesToBase64(bytes));
    expect(new TextDecoder().decode(decoded)).toBe(text);
  });

  test('round-trips content larger than one chunk', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  test('tolerates the newlines GitHub puts in blob payloads', () => {
    const bytes = new TextEncoder().encode('hello world');
    const wrapped = bytesToBase64(bytes).replace(/(.{4})/g, '$1\n');
    expect(base64ToBytes(wrapped)).toEqual(bytes);
  });
});

describe('parseRepoInput', () => {
  test.each([
    ['octo/notes', 'octo', 'notes'],
    ['https://github.com/octo/notes', 'octo', 'notes'],
    ['https://github.com/octo/notes.git', 'octo', 'notes'],
    ['https://github.com/octo/notes/tree/main/sub', 'octo', 'notes'],
    ['git@github.com:octo/notes.git', 'octo', 'notes'],
  ])('parses %s', (input, owner, repo) => {
    const result = parseRepoInput(input);
    expect(result).toEqual({ ok: true, value: { owner, repo } });
  });

  test.each([
    '',
    'octo',
    'https://gitlab.com/octo/notes',
    'octo/notes/extra/x/y',
  ])('rejects %s', (input) => {
    expect(parseRepoInput(input).ok).toBe(false);
  });
});

describe('listFiles', () => {
  test('returns plain blobs and drops trees, symlinks and submodules', async () => {
    const { api } = makeApi((url) => {
      if (url.includes('/git/ref/heads/main')) {
        return jsonResponse({ object: { sha: 'commit1' } });
      }
      if (url.includes('/git/commits/commit1')) {
        return jsonResponse({ tree: { sha: 'tree1' } });
      }
      return jsonResponse({
        truncated: false,
        tree: [
          { path: 'a.md', mode: '100644', type: 'blob', sha: 'sha-a', size: 3 },
          { path: 'dir', mode: '040000', type: 'tree', sha: 'sha-d' },
          { path: 'link', mode: '120000', type: 'blob', sha: 'sha-l' },
          { path: 'mod', mode: '160000', type: 'commit', sha: 'sha-m' },
          {
            path: 'n/b.md',
            mode: '100644',
            type: 'blob',
            sha: 'sha-b',
            size: 9,
          },
        ],
      });
    });

    await expect(api.listFiles()).resolves.toEqual([
      { path: 'a.md', sha: 'sha-a', size: 3 },
      { path: 'n/b.md', sha: 'sha-b', size: 9 },
    ]);
  });

  test('surfaces a truncated tree instead of silently losing files', async () => {
    const { api } = makeApi((url) => {
      if (url.includes('/git/ref/'))
        return jsonResponse({ object: { sha: 'c' } });
      if (url.includes('/git/commits/'))
        return jsonResponse({ tree: { sha: 't' } });
      return jsonResponse({ truncated: true, tree: [] });
    });

    await expect(api.listFiles()).rejects.toMatchObject({ code: 'too-large' });
  });
});

describe('error mapping', () => {
  test('401 becomes an auth error', async () => {
    const { api } = makeApi(() => new Response('bad creds', { status: 401 }));
    await expect(api.getHead()).rejects.toMatchObject({ code: 'auth' });
  });

  test('404 becomes not-found', async () => {
    const { api } = makeApi(() => new Response('nope', { status: 404 }));
    await expect(api.getHead()).rejects.toMatchObject({ code: 'not-found' });
  });

  test('exhausted budget reads as rate-limit, not auth', async () => {
    const { api } = makeApi(
      () =>
        new Response('limit', {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1700000000',
          },
        }),
    );
    const error = await api.getHead().catch((e) => e);
    expect(error).toBeInstanceOf(GithubApiError);
    expect(error.code).toBe('rate-limit');
    expect(error.retryAt).toBe(1700000000);
  });

  test('a 403 with budget remaining stays an auth error', async () => {
    const { api } = makeApi(
      () =>
        new Response('forbidden', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '4999' },
        }),
    );
    await expect(api.getHead()).rejects.toMatchObject({ code: 'auth' });
  });

  test('a failed fetch becomes a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const api = new GithubApi({
      owner: 'o',
      repo: 'r',
      branch: 'main',
      token: 't',
      fetchImpl,
    });
    await expect(api.getHead()).rejects.toMatchObject({ code: 'network' });
  });

  test('an abort propagates as an abort, not a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const api = new GithubApi({
      owner: 'o',
      repo: 'r',
      branch: 'main',
      token: 't',
      fetchImpl,
    });
    await expect(api.getHead()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('commitChanges', () => {
  test('writes blobs, builds one tree, and moves the ref once', async () => {
    const { api, calls } = makeApi((url, init) => {
      if (url.includes('/git/commits/head1')) {
        return jsonResponse({ tree: { sha: 'base-tree' } });
      }
      if (url.endsWith('/git/blobs')) {
        const body = JSON.parse(String(init.body));
        return jsonResponse({ sha: `blob-${body.content.slice(0, 4)}` });
      }
      if (url.endsWith('/git/trees')) return jsonResponse({ sha: 'new-tree' });
      if (url.endsWith('/git/commits'))
        return jsonResponse({ sha: 'new-commit' });
      return jsonResponse({});
    });

    const result = await api.commitChanges({
      message: 'sync',
      expectedHeadSha: 'head1',
      changes: [
        { type: 'write', path: 'a.md', bytes: new TextEncoder().encode('hi') },
        { type: 'delete', path: 'gone.md' },
      ],
    });

    expect(result.commitSha).toBe('new-commit');
    expect(Object.keys(result.writtenShas)).toEqual(['a.md']);

    const treeCall = calls.find((c) => c.url.endsWith('/git/trees'));
    expect(JSON.parse(String(treeCall?.init.body))).toEqual({
      base_tree: 'base-tree',
      tree: [
        { path: 'a.md', mode: '100644', type: 'blob', sha: 'blob-aGk=' },
        // A null sha is how the git data API spells a deletion.
        { path: 'gone.md', mode: '100644', type: 'blob', sha: null },
      ],
    });

    const commitCall = calls.find(
      (c) => c.url.endsWith('/git/commits') && c.init.method === 'POST',
    );
    expect(JSON.parse(String(commitCall?.init.body)).parents).toEqual([
      'head1',
    ]);

    const refCall = calls.find((c) => c.init.method === 'PATCH');
    expect(JSON.parse(String(refCall?.init.body))).toEqual({
      sha: 'new-commit',
      force: false,
    });
  });

  test('a branch that moved underneath us surfaces as a conflict', async () => {
    const { api } = makeApi((url, init) => {
      if (init.method === 'PATCH') {
        return new Response('not a fast forward', { status: 422 });
      }
      if (url.includes('/git/commits/head1')) {
        return jsonResponse({ tree: { sha: 'base-tree' } });
      }
      if (url.endsWith('/git/blobs')) return jsonResponse({ sha: 'blob1' });
      if (url.endsWith('/git/trees')) return jsonResponse({ sha: 'tree1' });
      if (url.endsWith('/git/commits')) return jsonResponse({ sha: 'commit1' });
      return jsonResponse({});
    });

    await expect(
      api.commitChanges({
        message: 'sync',
        expectedHeadSha: 'head1',
        changes: [{ type: 'write', path: 'a.md', bytes: new Uint8Array([1]) }],
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('verifyAccess', () => {
  test('reports a missing branch without throwing', async () => {
    const { api } = makeApi((url) => {
      if (url.includes('/branches/'))
        return new Response('no', { status: 404 });
      return jsonResponse({
        default_branch: 'main',
        permissions: { push: true },
      });
    });

    await expect(api.verifyAccess()).resolves.toEqual({
      defaultBranch: 'main',
      canPush: true,
      branchExists: false,
    });
  });

  test('a repo the token cannot see still throws', async () => {
    const { api } = makeApi(() => new Response('no', { status: 404 }));
    await expect(api.verifyAccess()).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});

describe('getAuthenticatedLogin', () => {
  test('returns the login a working token belongs to', async () => {
    const { api } = makeApi((url) =>
      url.endsWith('/user')
        ? jsonResponse({ login: 'octocat' })
        : new Response('no', { status: 404 }),
    );
    await expect(api.getAuthenticatedLogin()).resolves.toBe('octocat');
  });

  test('returns undefined for a bad token rather than throwing', async () => {
    // The caller is already handling one failure when it asks; a throw here
    // would replace a specific message with an unrelated one.
    const { api } = makeApi(() => new Response('bad creds', { status: 401 }));
    await expect(api.getAuthenticatedLogin()).resolves.toBeUndefined();
  });

  test('returns undefined when the network is down', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const api = new GithubApi({
      owner: 'o',
      repo: 'r',
      branch: 'main',
      token: 't',
      fetchImpl,
    });
    await expect(api.getAuthenticatedLogin()).resolves.toBeUndefined();
  });
});

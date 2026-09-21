import { base64ToBytes, bytesToBase64 } from './base64';
import { GithubApiError, type GithubErrorCode } from './errors';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** Regular non-executable file. Anything else in a tree is not a note. */
const BLOB_MODE = '100644';

export interface GithubRepoConfig {
  owner: string;
  repo: string;
  branch: string;
}

export interface GithubApiOptions extends GithubRepoConfig {
  token: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface RemoteEntry {
  /** Repo-relative POSIX path, e.g. `notes/today.md`. */
  path: string;
  /** Git blob sha — the identity we diff against, not a content hash. */
  sha: string;
  size: number;
}

export interface RemoteHead {
  commitSha: string;
  treeSha: string;
}

export type GithubChange =
  | { type: 'write'; path: string; bytes: Uint8Array }
  | { type: 'delete'; path: string };

export interface CommitResult {
  commitSha: string;
  treeSha: string;
  /** Blob sha per written path, so callers can record what they just pushed. */
  writtenShas: Record<string, string>;
}

export interface RepoAccess {
  defaultBranch: string;
  canPush: boolean;
  /** False when the branch named in the config does not exist yet. */
  branchExists: boolean;
}

function statusToCode(status: number): GithubErrorCode {
  switch (status) {
    case 401:
      return 'auth';
    case 403:
      return 'auth';
    case 404:
      return 'not-found';
    case 409:
    case 422:
      return 'conflict';
    default:
      return 'unknown';
  }
}

export class GithubApi {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  public readonly owner: string;
  public readonly repo: string;
  public readonly branch: string;

  constructor(options: GithubApiOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private get repoPath(): string {
    return `repos/${this.owner}/${this.repo}`;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { signal?: AbortSignal } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_ROOT}/${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': API_VERSION,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch (cause) {
      // An aborted sync is a normal control-flow signal, not a failure to
      // report — let it propagate untouched.
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        throw cause;
      }
      throw new GithubApiError('network', 'Could not reach GitHub', { cause });
    }

    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    }

    // A 403 with the remaining budget at zero is a rate limit, not a
    // permission problem, and the two need very different user-facing advice.
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (response.status === 403 && remaining === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      throw new GithubApiError('rate-limit', 'GitHub API rate limit reached', {
        status: response.status,
        retryAt: Number.isFinite(reset) ? reset : undefined,
      });
    }

    const detail = await response.text().catch(() => '');
    throw new GithubApiError(
      statusToCode(response.status),
      `GitHub request failed (${response.status}): ${detail.slice(0, 200)}`,
      { status: response.status },
    );
  }

  /**
   * Confirms the token can see the repo and reports whether it may push, so
   * workspace setup can fail loudly instead of on the first sync.
   */
  async verifyAccess(signal?: AbortSignal): Promise<RepoAccess> {
    const repo = await this.request<{
      default_branch: string;
      permissions?: { push?: boolean };
    }>(this.repoPath, { signal });

    let branchExists = true;
    try {
      await this.request(
        `${this.repoPath}/branches/${encodeURIComponent(this.branch)}`,
        { signal },
      );
    } catch (error) {
      if (error instanceof GithubApiError && error.code === 'not-found') {
        branchExists = false;
      } else {
        throw error;
      }
    }

    return {
      defaultBranch: repo.default_branch,
      // Fine-grained tokens omit `permissions` on some responses; treat a
      // missing value as "allowed" and let the first push be the real check.
      canPush: repo.permissions?.push ?? true,
      branchExists,
    };
  }

  async getHead(signal?: AbortSignal): Promise<RemoteHead> {
    const ref = await this.request<{ object: { sha: string } }>(
      `${this.repoPath}/git/ref/heads/${encodeURIComponent(this.branch)}`,
      { signal },
    );
    const commit = await this.request<{ tree: { sha: string } }>(
      `${this.repoPath}/git/commits/${ref.object.sha}`,
      { signal },
    );
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
  }

  /**
   * Lists every blob reachable from the branch head in one request. Returns
   * plain files only: directories, symlinks, and submodules are not notes.
   */
  async listFiles(signal?: AbortSignal): Promise<RemoteEntry[]> {
    const head = await this.getHead(signal);
    const tree = await this.request<{
      truncated: boolean;
      tree: Array<{
        path: string;
        mode: string;
        type: string;
        sha: string;
        size?: number;
      }>;
    }>(`${this.repoPath}/git/trees/${head.treeSha}?recursive=1`, { signal });

    if (tree.truncated) {
      throw new GithubApiError(
        'too-large',
        'Repository tree is too large to list in one request',
      );
    }

    return tree.tree
      .filter((entry) => entry.type === 'blob' && entry.mode === BLOB_MODE)
      .map((entry) => ({
        path: entry.path,
        sha: entry.sha,
        size: entry.size ?? 0,
      }));
  }

  async readBlob(sha: string, signal?: AbortSignal): Promise<Uint8Array> {
    const blob = await this.request<{ content: string; encoding: string }>(
      `${this.repoPath}/git/blobs/${sha}`,
      { signal },
    );

    if (blob.encoding !== 'base64') {
      throw new GithubApiError(
        'too-large',
        `Unsupported blob encoding "${blob.encoding}" — file is likely over 100MB`,
      );
    }

    return base64ToBytes(blob.content);
  }

  /**
   * Applies every change as a single commit on top of `expectedHeadSha`.
   *
   * Batching matters twice over: the repo history stays readable (one commit
   * per sync, not one per keystroke-save), and the ref update is the single
   * point where a concurrent push is detected. Passing `expectedHeadSha` makes
   * the update non-fast-forward-safe: if the branch moved while we were
   * building the tree, GitHub rejects it and we surface a 'conflict' so the
   * caller can re-sync rather than clobber.
   */
  async commitChanges(
    {
      changes,
      message,
      expectedHeadSha,
    }: {
      changes: GithubChange[];
      message: string;
      expectedHeadSha: string;
    },
    signal?: AbortSignal,
  ): Promise<CommitResult> {
    if (changes.length === 0) {
      throw new GithubApiError('unknown', 'No changes to commit');
    }

    const baseCommit = await this.request<{ tree: { sha: string } }>(
      `${this.repoPath}/git/commits/${expectedHeadSha}`,
      { signal },
    );

    const writtenShas: Record<string, string> = {};
    const treeEntries: Array<Record<string, unknown>> = [];

    for (const change of changes) {
      if (change.type === 'delete') {
        // A null sha is how the git data API spells "remove this path".
        treeEntries.push({
          path: change.path,
          mode: BLOB_MODE,
          type: 'blob',
          sha: null,
        });
        continue;
      }

      const blob = await this.request<{ sha: string }>(
        `${this.repoPath}/git/blobs`,
        {
          method: 'POST',
          signal,
          body: JSON.stringify({
            content: bytesToBase64(change.bytes),
            encoding: 'base64',
          }),
        },
      );
      writtenShas[change.path] = blob.sha;
      treeEntries.push({
        path: change.path,
        mode: BLOB_MODE,
        type: 'blob',
        sha: blob.sha,
      });
    }

    const tree = await this.request<{ sha: string }>(
      `${this.repoPath}/git/trees`,
      {
        method: 'POST',
        signal,
        body: JSON.stringify({
          base_tree: baseCommit.tree.sha,
          tree: treeEntries,
        }),
      },
    );

    const commit = await this.request<{ sha: string }>(
      `${this.repoPath}/git/commits`,
      {
        method: 'POST',
        signal,
        body: JSON.stringify({
          message,
          tree: tree.sha,
          parents: [expectedHeadSha],
        }),
      },
    );

    await this.request(
      `${this.repoPath}/git/refs/heads/${encodeURIComponent(this.branch)}`,
      {
        method: 'PATCH',
        signal,
        body: JSON.stringify({ sha: commit.sha, force: false }),
      },
    );

    return { commitSha: commit.sha, treeSha: tree.sha, writtenShas };
  }
}

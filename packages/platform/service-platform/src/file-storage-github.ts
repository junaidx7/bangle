import {
  BaseFileSystemError,
  FILE_ALREADY_EXISTS_ERROR,
  FILE_NOT_FOUND_ERROR,
  IndexedDBFileSystem,
} from '@bangle.io/baby-fs';
import {
  BaseService,
  type BaseServiceContext,
  throwAppError,
} from '@bangle.io/base-utils';
import {
  FILE_STORAGE_MAX_FILE_SIZE_BYTES,
  SERVICE_NAME,
  WORKSPACE_STORAGE_TYPE,
} from '@bangle.io/constants';
import { GithubApi, isGithubApiError } from '@bangle.io/github-api';
import type {
  BaseFileStorageProvider,
  FileStorageChangeEvent,
} from '@bangle.io/types';
import {
  isVisibleWorkspaceFilePath,
  toFSPathOrThrow,
  WsPath,
} from '@bangle.io/ws-path';
import { assertSameWorkspaceRename } from './file-storage-utils';
import {
  type PathDisposition,
  type SyncFs,
  type SyncResult,
  syncWorkspace,
} from './github-sync';
import { GithubSyncStore } from './github-sync-store';

export interface GithubWorkspaceConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export type GithubSyncStatus =
  | { type: 'idle'; lastSyncedAt: number | null }
  | { type: 'syncing' }
  | { type: 'error'; message: string; code: string }
  | { type: 'done'; result: SyncResult };

type Config = {
  onChange: (event: FileStorageChangeEvent) => void;
  /** Resolves the repo and token stored in this workspace's metadata. */
  getGithubConfig: (wsName: string) => Promise<GithubWorkspaceConfig>;
  onSyncStatusChange?: (wsName: string, status: GithubSyncStatus) => void;
};

/**
 * A GitHub-backed workspace that reads and writes a local IndexedDB mirror and
 * reconciles with the repo on an explicit sync.
 *
 * Every method on the storage interface touches the mirror only. That is the
 * whole point: notes open instantly, edits survive a dead connection on a
 * train, and the GitHub API is hit once per sync instead of once per
 * keystroke-triggered save — which would exhaust the hourly rate limit in
 * minutes and make the editor feel like a remote filesystem.
 */
export class FileStorageGithub
  extends BaseService
  implements BaseFileStorageProvider
{
  public readonly workspaceType = WORKSPACE_STORAGE_TYPE.Github;
  public readonly maxFileSizeBytes = FILE_STORAGE_MAX_FILE_SIZE_BYTES.github;

  private idb = new IndexedDBFileSystem();
  private syncStore = new GithubSyncStore();
  private onChange: (event: FileStorageChangeEvent) => void;
  private getGithubConfig: Config['getGithubConfig'];
  private onSyncStatusChange: Config['onSyncStatusChange'];
  /** One in-flight sync per workspace; a second request joins the first. */
  private inFlight = new Map<string, Promise<SyncResult>>();

  constructor(context: BaseServiceContext, dependencies: null, config: Config) {
    super(SERVICE_NAME.fileStorageGithubService, context, dependencies);
    this.onChange = config.onChange;
    this.getGithubConfig = config.getGithubConfig;
    this.onSyncStatusChange = config.onSyncStatusChange;
  }

  async hookMount(): Promise<void> {}

  private emitChange(event: FileStorageChangeEvent) {
    this.onChange(event);
  }

  /** Repo-relative path for a wsPath, i.e. the wsName prefix stripped. */
  private static toRepoPath(wsPath: string): string {
    return WsPath.fromString(wsPath).path;
  }

  private static toWsPath(wsName: string, repoPath: string): string {
    return WsPath.fromParts(wsName, repoPath).wsPath;
  }

  /**
   * Decides what a sync should do with one repo path.
   *
   * Two different exclusions live here. Paths the app deliberately ignores
   * (dotfiles, build output) are policy and stay silent. Paths the app cannot
   * name at all are not: workspace paths forbid `< > : " \\ | ? *`, which are
   * perfectly legal on GitHub and common in notes ("Does this move?.md"), so
   * those are reported instead of disappearing.
   *
   * Parsing safely is the point. Converting with `toWsPath` throws on exactly
   * these names, and one such file would abort the entire sync rather than
   * being skipped.
   */
  static classifyRepoPath(wsName: string, repoPath: string): PathDisposition {
    const result = WsPath.safeFromParts(wsName, repoPath);
    if (!result.ok || !result.data) {
      return 'unsupported';
    }
    return isVisibleWorkspaceFilePath(result.data.wsPath) ? 'sync' : 'ignore';
  }

  async createFile(wsPath: string, file: File): Promise<void> {
    await this.mountPromise;
    const fsPath = toFSPathOrThrow(wsPath);
    try {
      await this.idb.createFile(fsPath, file);
    } catch (error) {
      if (
        error instanceof BaseFileSystemError &&
        error.code === FILE_ALREADY_EXISTS_ERROR
      ) {
        throwAppError('error::file:already-existing', 'File already exists', {
          wsPath,
        });
      }
      throw error;
    }

    const wsName = WsPath.fromString(wsPath).wsName;
    await this.syncStore.markDirty(
      wsName,
      FileStorageGithub.toRepoPath(wsPath),
    );
    this.emitChange({ type: 'create', wsPath });
  }

  async deleteFile(wsPath: string): Promise<void> {
    await this.mountPromise;
    const fsPath = toFSPathOrThrow(wsPath);
    await this.idb.unlink(fsPath);

    const wsName = WsPath.fromString(wsPath).wsName;
    await this.syncStore.markDeleted(
      wsName,
      FileStorageGithub.toRepoPath(wsPath),
    );
    this.emitChange({ type: 'delete', wsPath });
  }

  async fileExists(wsPath: string): Promise<boolean> {
    await this.mountPromise;
    const fsPath = toFSPathOrThrow(wsPath);

    try {
      await this.idb.stat(fsPath);
      return true;
    } catch (error) {
      if (
        error instanceof BaseFileSystemError &&
        error.code === FILE_NOT_FOUND_ERROR
      ) {
        return false;
      }
      throw error;
    }
  }

  async fileStat(wsPath: string) {
    await this.mountPromise;
    const fsPath = toFSPathOrThrow(wsPath);
    const stat = await this.idb.stat(fsPath);
    return { ctime: stat.mtimeMs, mtime: stat.mtimeMs };
  }

  async listAllFiles(
    wsName: string,
    abortSignal: AbortSignal,
  ): Promise<string[]> {
    await this.mountPromise;
    const rawPaths: string[] = await this.idb.opendirRecursive(
      wsName,
      abortSignal,
    );
    abortSignal.throwIfAborted();

    return rawPaths
      .map((path) => WsPath.fromFSPath(path))
      .filter((path) => !!path)
      .map((path) => path.wsPath)
      .sort((a, b) => a.localeCompare(b));
  }

  async readFile(wsPath: string): Promise<File | undefined> {
    await this.mountPromise;
    if (!(await this.fileExists(wsPath))) {
      return undefined;
    }
    return this.idb.readFile(toFSPathOrThrow(wsPath));
  }

  async renameFile(
    wsPath: string,
    { newWsPath }: { newWsPath: string },
  ): Promise<void> {
    await this.mountPromise;
    assertSameWorkspaceRename(wsPath, newWsPath);

    try {
      await this.idb.rename(
        toFSPathOrThrow(wsPath),
        toFSPathOrThrow(newWsPath),
      );
    } catch (error) {
      if (
        error instanceof BaseFileSystemError &&
        error.code === FILE_ALREADY_EXISTS_ERROR
      ) {
        throwAppError('error::file:already-existing', 'File already exists', {
          wsPath: newWsPath,
        });
      }
      throw error;
    }

    // A rename is a delete plus a create as far as the repo is concerned:
    // git has no rename to record, only the resulting tree.
    const wsName = WsPath.fromString(wsPath).wsName;
    await this.syncStore.markDeleted(
      wsName,
      FileStorageGithub.toRepoPath(wsPath),
    );
    await this.syncStore.markDirty(
      wsName,
      FileStorageGithub.toRepoPath(newWsPath),
    );
    this.emitChange({ type: 'rename', oldWsPath: wsPath, newWsPath });
  }

  async writeFile(wsPath: string, file: File): Promise<void> {
    await this.mountPromise;
    const fsPath = toFSPathOrThrow(wsPath);
    try {
      await this.idb.writeExistingFile(fsPath, file);
    } catch (error) {
      if (
        error instanceof BaseFileSystemError &&
        error.code === FILE_NOT_FOUND_ERROR
      ) {
        throwAppError(
          'error::file-storage:file-does-not-exist',
          'Cannot write file as it does not exist',
          { wsPath, storage: this.name },
        );
      }
      throw error;
    }

    const wsName = WsPath.fromString(wsPath).wsName;
    await this.syncStore.markDirty(
      wsName,
      FileStorageGithub.toRepoPath(wsPath),
    );
    this.emitChange({ type: 'update', wsPath });
  }

  /** Bridges the mirror to the sync engine in repo-relative terms. */
  private syncFs(): SyncFs {
    return {
      listPaths: async (wsName, signal) => {
        const raw: string[] = await this.idb.opendirRecursive(wsName, signal);
        return raw
          .map((path) => WsPath.fromFSPath(path))
          .filter((path) => !!path)
          .map((path) => path.path);
      },
      read: async (wsName, repoPath) => {
        const wsPath = FileStorageGithub.toWsPath(wsName, repoPath);
        const file = await this.readFile(wsPath);
        if (!file) return undefined;
        return new Uint8Array(await file.arrayBuffer());
      },
      write: async (wsName, repoPath, bytes) => {
        const wsPath = FileStorageGithub.toWsPath(wsName, repoPath);
        const fsPath = toFSPathOrThrow(wsPath);
        const name = repoPath.split('/').pop() ?? repoPath;
        // A fresh Uint8Array copy keeps File off the engine's buffer, which
        // may be a view into a larger pooled allocation.
        const file = new File([new Uint8Array(bytes)], name);
        await this.idb.writeFile(fsPath, file);
      },
      remove: async (wsName, repoPath) => {
        const wsPath = FileStorageGithub.toWsPath(wsName, repoPath);
        await this.idb.unlink(toFSPathOrThrow(wsPath));
      },
    };
  }

  /**
   * Pulls, pushes, and reports what moved. Concurrent callers share one run:
   * two overlapping syncs against the same branch would race on the ref and
   * one would fail with a spurious conflict.
   */
  async sync(wsName: string, signal?: AbortSignal): Promise<SyncResult> {
    await this.mountPromise;

    const existing = this.inFlight.get(wsName);
    if (existing) {
      return existing;
    }

    const run = this.runSync(wsName, signal).finally(() => {
      this.inFlight.delete(wsName);
    });
    this.inFlight.set(wsName, run);
    return run;
  }

  private async runSync(
    wsName: string,
    signal?: AbortSignal,
  ): Promise<SyncResult> {
    this.onSyncStatusChange?.(wsName, { type: 'syncing' });

    try {
      const config = await this.getGithubConfig(wsName);
      const api = new GithubApi(config);
      const state = await this.syncStore.get(wsName);

      const { result, state: nextState } = await syncWorkspace({
        wsName,
        api,
        fs: this.syncFs(),
        state,
        signal,
        classifyPath: (repoPath) =>
          FileStorageGithub.classifyRepoPath(wsName, repoPath),
      });

      await this.syncStore.set(wsName, nextState);

      // Tell the app what moved so open editors and the file tree refresh
      // instead of showing content the sync has already replaced.
      for (const path of result.pulled) {
        this.emitChange({
          type: 'update',
          wsPath: FileStorageGithub.toWsPath(wsName, path),
        });
      }
      for (const path of result.deletedLocally) {
        this.emitChange({
          type: 'delete',
          wsPath: FileStorageGithub.toWsPath(wsName, path),
        });
      }
      for (const conflict of result.conflicts) {
        if (conflict.conflictPath !== conflict.path) {
          this.emitChange({
            type: 'create',
            wsPath: FileStorageGithub.toWsPath(wsName, conflict.conflictPath),
          });
        }
      }

      this.onSyncStatusChange?.(wsName, { type: 'done', result });
      return result;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.onSyncStatusChange?.(wsName, {
          type: 'idle',
          lastSyncedAt: null,
        });
        throw error;
      }

      const code = isGithubApiError(error) ? error.code : 'unknown';
      this.onSyncStatusChange?.(wsName, {
        type: 'error',
        code,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Drops a workspace's sync bookkeeping; used when it is removed. */
  async forgetWorkspace(wsName: string): Promise<void> {
    await this.syncStore.clear(wsName);
  }
}

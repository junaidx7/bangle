import type { WorkspaceStorageType } from '@bangle.io/constants';

type WsPath = string;

export interface FileStat {
  /**
   * The creation timestamp in milliseconds elapsed since January 1, 1970 00:00:00 UTC.
   */
  ctime: number;
  /**
   * The modification timestamp in milliseconds, if never modified this should match creation timestamp.
   */
  mtime: number;
}

export type FileStorageChangeEvent =
  | {
      type: 'create';
      wsPath: string;
    }
  | {
      type: 'delete';
      wsPath: string;
    }
  | {
      type: 'rename';
      oldWsPath: string;
      newWsPath: string;
    }
  | {
      type: 'update';
      wsPath: string;
    };

/**
 * A storage-provider hint that workspace files changed. Watchers may also
 * report this app's own writes because platform records do not carry writer
 * identity. `update` invalidates content at an existing path; `refresh` is the
 * structural revalidation boundary when the provider only knows "something
 * changed". A workspace name scopes the refresh when known; absent means
 * app-wide.
 */
export type FileStorageExternalChangeEvent =
  | {
      type: 'update';
      wsPath: string;
    }
  | {
      type: 'refresh';
      wsName?: string;
    };

type EmptyObject = Record<string, never>;

export interface BaseFileStorageProvider {
  readonly maxFileSizeBytes: number;
  readonly workspaceType: WorkspaceStorageType;

  /**
   * Creates a new file. Implementations must reject with
   * `error::file:already-existing` when the target exists and must not
   * overwrite existing content.
   */
  createFile: (
    wsPath: WsPath,
    file: File,
    options: EmptyObject,
  ) => Promise<void>;

  deleteFile: (wsPath: WsPath, options: EmptyObject) => Promise<void>;

  fileExists: (wsPath: WsPath, options: EmptyObject) => Promise<boolean>;

  fileStat: (wsPath: WsPath, options: EmptyObject) => Promise<FileStat>;

  readFile: (wsPath: WsPath, options: EmptyObject) => Promise<File | undefined>;

  listAllFiles: (
    wsName: string,
    abortSignal: AbortSignal,
    options: EmptyObject,
  ) => Promise<WsPath[]>;

  /**
   * Renames one file within its workspace without overwriting an existing
   * destination. Implementations must reject destination conflicts with
   * `error::file:already-existing` and cross-workspace renames with
   * `error::file:invalid-operation`.
   */
  renameFile: (
    wsPath: WsPath,
    options: {
      newWsPath: WsPath;
    },
  ) => Promise<void>;

  /**
   * sha - gitsha of the file
   */
  writeFile: (
    wsPath: WsPath,
    file: File,
    options: EmptyObject,
  ) => Promise<void>;
}

export interface FileStorageConflict {
  /** Repo-relative path both sides changed. */
  path: string;
  /** Where the local version was parked; equals `path` when nothing moved. */
  conflictPath: string;
  reason:
    | 'both-edited'
    | 'both-created'
    | 'deleted-remotely'
    | 'deleted-locally';
}

export interface FileStorageSyncResult {
  pulled: string[];
  pushed: string[];
  deletedLocally: string[];
  deletedRemotely: string[];
  conflicts: FileStorageConflict[];
  /**
   * Remote paths this app cannot represent, so they were left untouched on
   * both sides. Reported rather than dropped quietly: the file is real and
   * visible on GitHub, and silence would look like data loss.
   */
  skipped: string[];
  /** Null when the sync was read-only, i.e. nothing local needed pushing. */
  commitSha: string | null;
  headSha: string;
}

/**
 * Capability marker for providers backed by a remote that must be reconciled
 * explicitly, as opposed to a local disk that is always already current.
 *
 * Kept optional and feature-detected so the core file-system service can offer
 * "sync this workspace" without every storage type having to pretend it means
 * something.
 */
export interface SyncableFileStorageProvider {
  sync: (
    wsName: string,
    abortSignal?: AbortSignal,
  ) => Promise<FileStorageSyncResult>;
}

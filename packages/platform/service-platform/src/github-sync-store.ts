import type { DBSchema, IDBPDatabase } from 'idb';
import * as idb from 'idb';

const DB_NAME = 'bangle-github-sync-1';
const STORE_NAME = 'workspace-sync-state';

/**
 * What we believe about one path the last time local and remote agreed.
 *
 * `syncedSha` is the pivot the whole sync algorithm turns on: comparing it to
 * the current remote sha tells us whether the remote moved, and `dirty` tells
 * us whether local moved. Those two bits are what separate a clean pull, a
 * clean push, and a genuine conflict.
 */
export interface SyncRecord {
  /** Blob sha both sides last agreed on; null means the file is local-only. */
  syncedSha: string | null;
  /** Local content has changed since `syncedSha`. */
  dirty: boolean;
  /** Deleted locally, not yet pushed. Kept as a tombstone so the delete survives. */
  deleted: boolean;
}

export interface WorkspaceSyncState {
  /** Keyed by repo-relative path. */
  records: Record<string, SyncRecord>;
  /** Branch head at the end of the last successful sync. */
  lastHeadSha: string | null;
  lastSyncedAt: number | null;
}

interface SyncSchema extends DBSchema {
  [STORE_NAME]: {
    key: string;
    value: WorkspaceSyncState;
  };
}

export function emptySyncState(): WorkspaceSyncState {
  return { records: {}, lastHeadSha: null, lastSyncedAt: null };
}

export class GithubSyncStore {
  private dbPromise: Promise<IDBPDatabase<SyncSchema>> | undefined;

  private getDb(): Promise<IDBPDatabase<SyncSchema>> {
    this.dbPromise ??= idb.openDB<SyncSchema>(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore(STORE_NAME);
      },
    });
    return this.dbPromise;
  }

  async get(wsName: string): Promise<WorkspaceSyncState> {
    const db = await this.getDb();
    return (await db.get(STORE_NAME, wsName)) ?? emptySyncState();
  }

  async set(wsName: string, state: WorkspaceSyncState): Promise<void> {
    const db = await this.getDb();
    await db.put(STORE_NAME, state, wsName);
  }

  async clear(wsName: string): Promise<void> {
    const db = await this.getDb();
    await db.delete(STORE_NAME, wsName);
  }

  /**
   * Read-modify-write in one transaction. Editor saves and a running sync both
   * touch this state, so a plain get/put pair would let one silently drop the
   * other's record.
   */
  async update(
    wsName: string,
    mutate: (state: WorkspaceSyncState) => WorkspaceSyncState,
  ): Promise<WorkspaceSyncState> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const current = (await tx.store.get(wsName)) ?? emptySyncState();
    const next = mutate(current);
    await tx.store.put(next, wsName);
    await tx.done;
    return next;
  }

  /** Marks a path as locally modified, preserving whatever sha we last synced. */
  async markDirty(wsName: string, path: string): Promise<void> {
    await this.update(wsName, (state) => ({
      ...state,
      records: {
        ...state.records,
        [path]: {
          syncedSha: state.records[path]?.syncedSha ?? null,
          dirty: true,
          deleted: false,
        },
      },
    }));
  }

  /**
   * Records a local delete. A file we never pushed can just disappear; one the
   * remote knows about needs a tombstone so the next sync deletes it there too.
   */
  async markDeleted(wsName: string, path: string): Promise<void> {
    await this.update(wsName, (state) => {
      const existing = state.records[path];
      if (!existing || existing.syncedSha === null) {
        const { [path]: _removed, ...rest } = state.records;
        return { ...state, records: rest };
      }
      return {
        ...state,
        records: {
          ...state.records,
          [path]: { ...existing, dirty: false, deleted: true },
        },
      };
    });
  }
}

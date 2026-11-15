import Dexie, { type Table } from 'dexie';
import type { Annotation, DocRecord, PageRecord } from './types';

export interface FileRecord {
  docId: string;
  blob: Blob;
  /** set when the change still has to be synced */
  dirty?: number;
}

/** Something deleted on this device that still has to be deleted in the cloud. */
export interface Tombstone {
  kind: SyncKind;
  key: string;
  at: number;
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

export type SyncKind = 'docs' | 'pages' | 'annotations' | 'files';

class AppDB extends Dexie {
  docs!: Table<DocRecord, string>;
  pages!: Table<PageRecord, [string, number]>;
  files!: Table<FileRecord, string>;
  annotations!: Table<Annotation, string>;
  tombstones!: Table<Tombstone, [SyncKind, string]>;
  meta!: Table<MetaRecord, string>;

  constructor() {
    super('read-aloud');
    this.version(1).stores({
      docs: 'id, openedAt',
      pages: '[docId+page], docId, status',
      files: 'docId',
      annotations: 'id, docId',
    });
    // v2: cloud sync. `dirty` marks records changed since the last sync.
    this.version(2).stores({
      docs: 'id, openedAt, dirty',
      pages: '[docId+page], docId, status, dirty',
      files: 'docId, dirty',
      annotations: 'id, docId, dirty',
      tombstones: '[kind+key]',
      meta: 'key',
    });
  }
}

export const db = new AppDB();

export async function deleteDoc(id: string): Promise<void> {
  await db.transaction('rw', [db.docs, db.pages, db.files, db.annotations], async () => {
    await db.docs.delete(id);
    await db.pages.where('docId').equals(id).delete();
    await db.files.delete(id);
    await db.annotations.where('docId').equals(id).delete();
  });
}

export const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

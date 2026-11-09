import Dexie, { type Table } from 'dexie';
import type { Annotation, DocRecord, PageRecord } from './types';

export interface FileRecord {
  docId: string;
  blob: Blob;
}

class AppDB extends Dexie {
  docs!: Table<DocRecord, string>;
  pages!: Table<PageRecord, [string, number]>;
  files!: Table<FileRecord, string>;
  annotations!: Table<Annotation, string>;

  constructor() {
    super('read-aloud');
    this.version(1).stores({
      docs: 'id, openedAt',
      pages: '[docId+page], docId, status',
      files: 'docId',
      annotations: 'id, docId',
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

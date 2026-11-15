import Dexie, { type Table, type Transaction } from 'dexie';
import { db, type FileRecord, type SyncKind } from './db';
import { applyRemoteSetting, dirtySettings, readSetting, setDirtySettings, SETTINGS_EVENT, SYNCED_SETTINGS } from './settingsSync';
import type { Annotation, DocRecord, PageRecord } from './types';

/** One synced item as stored in the cloud. */
export interface RemoteRow {
  kind: 'docs' | 'pages' | 'annotations' | 'settings';
  key: string;
  data: unknown;
  deleted: boolean;
  /** increases with every write on the server */
  seq?: number;
}

/** What the sync engine needs from the cloud (Supabase in the app, a fake in tests). */
export interface Remote {
  upsert(rows: RemoteRow[]): Promise<void>;
  /** rows with seq > `after`, oldest first */
  pull(after: number, limit: number): Promise<RemoteRow[]>;
  uploadFile(docId: string, blob: Blob): Promise<void>;
  downloadFile(docId: string): Promise<Blob | null>;
  deleteFile(docId: string): Promise<void>;
}

export interface SyncStatus {
  state: 'off' | 'syncing' | 'idle' | 'offline' | 'error';
  lastSynced?: number;
  error?: string;
  /** files that couldn't be uploaded (e.g. too big); they stay on this device */
  skippedFiles?: string[];
}

type Keyed = {
  kind: SyncKind;
  table: Table<any, any>;
  key: (r: any) => string;
  /** sync key -> IndexedDB primary key */
  pk: (key: string) => unknown;
  /** IndexedDB primary key -> sync key */
  fromPk: (pk: any) => string;
};

const KINDS: Keyed[] = [
  { kind: 'docs', table: db.docs, key: (r: DocRecord) => r.id, pk: (k) => k, fromPk: (pk: string) => pk },
  { kind: 'pages', table: db.pages, key: (r: PageRecord) => `${r.docId}|${r.page}`, pk: (k) => pageKey(k), fromPk: (pk: [string, number]) => `${pk[0]}|${pk[1]}` },
  { kind: 'annotations', table: db.annotations, key: (r: Annotation) => r.id, pk: (k) => k, fromPk: (pk: string) => pk },
  { kind: 'files', table: db.files, key: (r: FileRecord) => r.docId, pk: (k) => k, fromPk: (pk: string) => pk },
];

function pageKey(k: string): [string, number] {
  const i = k.lastIndexOf('|');
  return [k.slice(0, i), Number(k.slice(i + 1))];
}

const BATCH = 100;

// --- change tracking --------------------------------------------------------

type TaggedTx = Transaction & { __fromSync?: boolean; parent?: TaggedTx };
const isFromSync = (tx: TaggedTx | undefined): boolean => !!tx && (!!tx.__fromSync || isFromSync(tx.parent));

/** Run `fn` in a transaction whose writes are NOT treated as local changes. */
function syncTransaction<T>(tables: Table<any, any>[], fn: () => Promise<T>): Promise<T> {
  return db.transaction('rw', tables, async () => {
    (Dexie.currentTransaction as TaggedTx).__fromSync = true;
    return fn();
  });
}

let rev = Date.now();
let onLocalChange: () => void = () => {};
let hooksInstalled = false;

/** Mark every local write so it gets synced; remember deletions as tombstones. */
export function installChangeTracking() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  for (const k of KINDS) {
    k.table.hook('creating', function (_pk, obj, tx) {
      if (!isFromSync(tx as TaggedTx)) {
        obj.dirty = ++rev;
        (tx as Transaction).on('complete', () => onLocalChange());
      }
    });
    k.table.hook('updating', function (mods, _pk, _obj, tx) {
      if (isFromSync(tx as TaggedTx)) return undefined;
      const keys = Object.keys(mods);
      if (keys.length === 1 && keys[0] === 'dirty') return undefined;
      (tx as Transaction).on('complete', () => onLocalChange());
      return { dirty: ++rev };
    });
    k.table.hook('deleting', function (pk, _obj, tx) {
      if (isFromSync(tx as TaggedTx)) return;
      const key = k.fromPk(pk);
      (tx as Transaction).on('complete', () => {
        void db.tombstones.put({ kind: k.kind, key, at: Date.now() }).then(() => onLocalChange());
      });
    });
  }
}

/** Strip local-only fields before uploading. */
function toData(r: Record<string, unknown>) {
  const { dirty: _dirty, ...rest } = r;
  void _dirty;
  return rest;
}

// --- engine -----------------------------------------------------------------

export class SyncEngine {
  status: SyncStatus = { state: 'off' };
  private listeners = new Set<() => void>();
  private remote: Remote | null = null;
  private userId: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getStatus = () => this.status;

  private setStatus(s: Partial<SyncStatus>) {
    this.status = { ...this.status, ...s };
    this.listeners.forEach((l) => l());
  }

  private readonly onSettings = (e: Event) => {
    if ((e as CustomEvent).detail?.local) this.schedule();
  };
  private readonly onOnline = () => this.schedule(0);
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') this.schedule(0);
  };

  /** Begin syncing for a signed-in user. */
  async start(remote: Remote, userId: string) {
    installChangeTracking();
    this.remote = remote;
    this.userId = userId;
    onLocalChange = () => this.schedule();
    if (typeof window !== 'undefined') {
      window.addEventListener(SETTINGS_EVENT, this.onSettings);
      window.addEventListener('online', this.onOnline);
      document.addEventListener('visibilitychange', this.onVisible);
      this.interval = setInterval(() => this.schedule(0), 60_000);
    }
    // First sign-in on this device: upload everything that's already here.
    const flag = `fullPush:${userId}`;
    if (!(await db.meta.get(flag))) {
      for (const k of KINDS) await k.table.toCollection().modify((r: { dirty?: number }) => void (r.dirty = ++rev));
      setDirtySettings([...dirtySettings(), ...SYNCED_SETTINGS.filter((s) => readSetting(s) !== undefined)]);
      await db.meta.put({ key: flag, value: true });
    }
    await this.syncNow();
  }

  stop() {
    this.remote = null;
    this.userId = null;
    onLocalChange = () => {};
    clearTimeout(this.timer);
    clearInterval(this.interval);
    if (typeof window !== 'undefined') {
      window.removeEventListener(SETTINGS_EVENT, this.onSettings);
      window.removeEventListener('online', this.onOnline);
      document.removeEventListener('visibilitychange', this.onVisible);
    }
    this.setStatus({ state: 'off', error: undefined });
  }

  /** Sync soon (changes come in bursts, e.g. reading position). */
  schedule(delay = 2000) {
    if (!this.remote) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.syncNow(), delay);
  }

  /** Pull then push. Concurrent calls are merged into one more run. */
  syncNow(): Promise<void> {
    if (!this.remote) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          this.setStatus({ state: 'offline' });
          break;
        }
        this.setStatus({ state: 'syncing' });
        try {
          await this.pull();
          await this.push();
          this.setStatus({ state: 'idle', lastSynced: Date.now(), error: undefined });
        } catch (e) {
          console.error('Sync failed', e);
          this.setStatus({ state: 'error', error: e instanceof Error ? e.message : String(e) });
          break;
        }
      } while (this.again && this.remote);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private cursorKey() {
    return `cursor:${this.userId}`;
  }

  private async pull() {
    const remote = this.remote!;
    let cursor = ((await db.meta.get(this.cursorKey()))?.value as number) ?? 0;
    const firstPull = cursor === 0;
    for (;;) {
      const rows = await remote.pull(cursor, 500);
      if (!rows.length) break;
      await this.apply(rows, firstPull);
      cursor = Math.max(cursor, ...rows.map((r) => r.seq ?? 0));
      await db.meta.put({ key: this.cursorKey(), value: cursor });
      if (rows.length < 500) break;
    }
  }

  /** Apply cloud rows locally. Local changes not yet uploaded win. */
  async apply(rows: RemoteRow[], firstPull = false) {
    const settings = rows.filter((r) => r.kind === 'settings');
    if (settings.length) {
      const dirty = new Set(dirtySettings());
      for (const r of settings) {
        // On a device's first pull the account's settings win over local defaults.
        if (dirty.has(r.key) && !firstPull) continue;
        dirty.delete(r.key);
        if (!r.deleted) applyRemoteSetting(r.key, r.data);
      }
      setDirtySettings([...dirty]);
    }
    const records = rows.filter((r) => r.kind !== 'settings');
    if (!records.length) return;
    await syncTransaction([db.docs, db.pages, db.annotations, db.files, db.tombstones], async () => {
      for (const r of records) {
        const k = KINDS.find((x) => x.kind === r.kind);
        if (!k) continue;
        const pk = k.pk(r.key);
        const local = (await k.table.get(pk as never)) as { dirty?: number } | undefined;
        if (local?.dirty) continue; // unsynced local edit wins
        if (await db.tombstones.get([k.kind, r.key])) continue; // deleted here, not yet pushed
        if (r.deleted) {
          await k.table.delete(pk as never);
          if (k.kind === 'docs') await db.files.delete(r.key);
        } else {
          await k.table.put(r.data as never);
        }
      }
    });
  }

  private async push() {
    const remote = this.remote!;
    const skippedFiles: string[] = [];
    for (const k of KINDS) {
      for (;;) {
        const batch = (await k.table.where('dirty').above(0).limit(k.kind === 'files' ? 1 : BATCH).toArray()) as Record<string, unknown>[];
        if (!batch.length) break;
        if (k.kind === 'files') {
          const f = batch[0] as unknown as FileRecord;
          try {
            await remote.uploadFile(f.docId, f.blob);
          } catch (e) {
            // Too large for the storage plan, etc.: keep it on this device only.
            console.warn('File not synced', f.docId, e);
            skippedFiles.push(f.docId);
          }
        } else {
          await remote.upsert(batch.map((r) => ({ kind: k.kind as RemoteRow['kind'], key: k.key(r), data: toData(r), deleted: false })));
        }
        // Mark clean, unless the record changed again while uploading.
        await syncTransaction([k.table], async () => {
          for (const r of batch) {
            const pk = k.pk(k.key(r));
            const cur = (await k.table.get(pk as never)) as { dirty?: number } | undefined;
            if (cur && cur.dirty === r.dirty) await k.table.update(pk as never, { dirty: undefined } as never);
          }
        });
      }
    }
    // Deletions.
    const tombs = await db.tombstones.toArray();
    const deletes: RemoteRow[] = [];
    for (const t of tombs) {
      const k = KINDS.find((x) => x.kind === t.kind)!;
      if (await k.table.get(k.pk(t.key) as never)) continue; // re-created since
      if (t.kind === 'files') await remote.deleteFile(t.key).catch((e) => console.warn('File delete failed', e));
      else deletes.push({ kind: t.kind as RemoteRow['kind'], key: t.key, data: null, deleted: true });
    }
    for (let i = 0; i < deletes.length; i += BATCH) await remote.upsert(deletes.slice(i, i + BATCH));
    await db.tombstones.bulkDelete(tombs.map((t) => [t.kind, t.key] as [SyncKind, string]));
    // Settings.
    const keys = dirtySettings();
    if (keys.length) {
      await remote.upsert(keys.map((key) => ({ kind: 'settings', key, data: readSetting(key) ?? null, deleted: readSetting(key) === undefined })));
      setDirtySettings(dirtySettings().filter((k) => !keys.includes(k)));
    }
    this.setStatus({ skippedFiles: skippedFiles.length ? skippedFiles : undefined });
  }

  /** The original file for a document: from this device, or downloaded from the cloud. */
  async loadFile(docId: string): Promise<Blob | null> {
    const local = await db.files.get(docId);
    if (local) return local.blob;
    if (!this.remote) return null;
    const blob = await this.remote.downloadFile(docId);
    if (blob) await syncTransaction([db.files], async () => void (await db.files.put({ docId, blob })));
    return blob;
  }
}

export const sync = new SyncEngine();

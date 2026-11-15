import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

// Minimal localStorage for node.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const { db, deleteDoc } = await import('../db');
const { SyncEngine, installChangeTracking } = await import('../sync');
type Remote = import('../sync').Remote;
type RemoteRow = import('../sync').RemoteRow;
const { saveSetting } = await import('../settingsSync');

/** In-memory stand-in for the Supabase `records` table + storage bucket. */
class FakeRemote implements Remote {
  rows = new Map<string, RemoteRow>();
  files = new Map<string, Blob>();
  seq = 0;
  async upsert(rows: RemoteRow[]) {
    for (const r of rows) this.rows.set(`${r.kind}|${r.key}`, { ...structuredClone(r), seq: ++this.seq });
  }
  async pull(after: number, limit: number) {
    return [...this.rows.values()].filter((r) => r.seq! > after).sort((a, b) => a.seq! - b.seq!).slice(0, limit).map((r) => structuredClone(r));
  }
  async uploadFile(id: string, b: Blob) {
    this.files.set(id, b);
  }
  async downloadFile(id: string) {
    return this.files.get(id) ?? null;
  }
  async deleteFile(id: string) {
    this.files.delete(id);
  }
  get(kind: string, key: string) {
    return this.rows.get(`${kind}|${key}`);
  }
}

const doc = (id: string, extra = {}) => ({ id, title: id, kind: 'txt' as const, fileName: `${id}.txt`, createdAt: 1, openedAt: 1, pageCount: 1, ocrPending: 0, progress: 0, ...extra });
const page = (docId: string, text: string) => ({ docId, page: 1, status: 'ready' as const, blocks: [{ id: '1-0', page: 1, text, sentences: [[0, text.length]] as [number, number][] }] });

/** A fresh browser: delete the database itself (not a user deleting things). */
async function wipeLocal() {
  await new Promise((r) => setTimeout(r, 20)); // let pending tombstone writes land first
  db.close();
  await db.delete();
  await db.open();
  store.clear();
}

describe('sync engine', () => {
  let remote: FakeRemote;
  let engine: InstanceType<typeof SyncEngine>;

  beforeEach(async () => {
    installChangeTracking();
    await wipeLocal();
    remote = new FakeRemote();
    engine = new SyncEngine();
  });

  it('uploads what is already on the device at first sign-in, then only changes', async () => {
    await db.docs.add(doc('a'));
    await db.pages.add(page('a', 'Hello world.'));
    await engine.start(remote, 'user1');
    expect(remote.get('docs', 'a')?.data).toMatchObject({ id: 'a', title: 'a' });
    expect(remote.get('docs', 'a')?.data).not.toHaveProperty('dirty');
    expect(remote.get('pages', 'a|1')).toBeTruthy();
    expect(await db.docs.where('dirty').above(0).count()).toBe(0);

    await db.docs.update('a', { title: 'Renamed' });
    expect((await db.docs.get('a'))?.dirty).toBeGreaterThan(0);
    await engine.syncNow();
    expect(remote.get('docs', 'a')?.data).toMatchObject({ title: 'Renamed' });
    engine.stop();
  });

  it('a second computer gets the whole library, and edits flow back', async () => {
    await db.docs.add(doc('a', { position: { blockId: '1-0', sentence: 0 } }));
    await db.pages.add(page('a', 'Hello world.'));
    await db.annotations.add({ id: 'n1', docId: 'a', ranges: [{ blockId: '1-0', start: 0, end: 5 }], quote: 'Hello', color: 'yellow', note: 'hi', createdAt: 1, updatedAt: 1 });
    await engine.start(remote, 'user1');
    engine.stop();

    // "Computer B": empty browser, same account.
    await wipeLocal();
    const b = new SyncEngine();
    await b.start(remote, 'user1');
    expect((await db.docs.get('a'))?.title).toBe('a');
    expect((await db.pages.get(['a', 1]))?.blocks[0].text).toBe('Hello world.');
    expect((await db.annotations.get('n1'))?.note).toBe('hi');
    // Pulled records aren't marked as local changes.
    expect(await db.docs.where('dirty').above(0).count()).toBe(0);

    await db.annotations.update('n1', { note: 'edited on B' });
    await b.syncNow();
    expect((remote.get('annotations', 'n1')?.data as { note: string }).note).toBe('edited on B');
    b.stop();
  });

  it('a local edit that has not been uploaded yet wins over an older cloud copy', async () => {
    await engine.start(remote, 'user1');
    await db.docs.add(doc('a', { title: 'local' }));
    await remote.upsert([{ kind: 'docs', key: 'a', data: doc('a', { title: 'remote' }), deleted: false }]);
    await engine.syncNow();
    expect((await db.docs.get('a'))?.title).toBe('local');
    expect((remote.get('docs', 'a')?.data as { title: string }).title).toBe('local');
    engine.stop();
  });

  it('deleting a document deletes it in the cloud and on other computers', async () => {
    await db.docs.add(doc('a'));
    await db.pages.add(page('a', 'Hi.'));
    await engine.start(remote, 'user1');
    await deleteDoc('a');
    await new Promise((r) => setTimeout(r, 20)); // tombstones are written after the delete commits
    await engine.syncNow();
    expect(remote.get('docs', 'a')?.deleted).toBe(true);
    expect(remote.get('pages', 'a|1')?.deleted).toBe(true);
    expect(await db.tombstones.count()).toBe(0);
    engine.stop();

    // Another computer that still has it removes it on next sync.
    await wipeLocal();
    await db.docs.add(doc('a'));
    await db.docs.update('a', { dirty: undefined } as never);
    await db.meta.put({ key: 'fullPush:user1', value: true });
    const b = new SyncEngine();
    await b.start(remote, 'user1');
    expect(await db.docs.get('a')).toBeUndefined();
    b.stop();
  });

  it('re-creating pages (re-read text) does not delete them in the cloud', async () => {
    await db.docs.add(doc('a'));
    await db.pages.add(page('a', 'Old.'));
    await engine.start(remote, 'user1');
    await db.transaction('rw', db.pages, async () => {
      await db.pages.where('docId').equals('a').delete();
      await db.pages.add(page('a', 'New.'));
    });
    await new Promise((r) => setTimeout(r, 20));
    await engine.syncNow();
    expect(remote.get('pages', 'a|1')?.deleted).toBe(false);
    expect((remote.get('pages', 'a|1')?.data as { blocks: { text: string }[] }).blocks[0].text).toBe('New.');
    engine.stop();
  });

  it('syncs settings; the account wins over a new computer\'s defaults', async () => {
    saveSetting('read-aloud:pronunciations', [{ id: '1', from: 'ATP', to: 'A T P' }]);
    await engine.start(remote, 'user1');
    expect(remote.get('settings', 'read-aloud:pronunciations')?.data).toEqual([{ id: '1', from: 'ATP', to: 'A T P' }]);
    engine.stop();

    await wipeLocal();
    saveSetting('read-aloud:pronunciations', []); // new computer's default
    const b = new SyncEngine();
    await b.start(remote, 'user1');
    expect(JSON.parse(localStorage.getItem('read-aloud:pronunciations')!)).toEqual([{ id: '1', from: 'ATP', to: 'A T P' }]);
    b.stop();
  });

  it('uploads PDFs and downloads them on demand elsewhere', async () => {
    await db.docs.add(doc('p', { kind: 'pdf' }));
    await db.files.add({ docId: 'p', blob: new Blob(['%PDF-1.4 test']) });
    await engine.start(remote, 'user1');
    expect(remote.files.has('p')).toBe(true);
    engine.stop();

    await wipeLocal();
    const b = new SyncEngine();
    await b.start(remote, 'user1');
    expect(await db.files.get('p')).toBeUndefined(); // not downloaded until needed
    const blob = await b.loadFile('p');
    expect(await blob?.text()).toBe('%PDF-1.4 test');
    expect(await db.files.get('p')).toBeTruthy();
    // Downloaded copy isn't re-uploaded.
    expect(await db.files.where('dirty').above(0).count()).toBe(0);
    b.stop();
  });
});

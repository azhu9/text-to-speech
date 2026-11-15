import { db, newId } from './db';
import { extractPdf } from './pdf';
import { makeBlock } from './segment';
import { sync } from './sync';
import { markdownToParagraphs, textToParagraphs, type Paragraph } from './textImport';
import type { DocKind, DocRecord, PageRecord } from './types';

export const ACCEPT = '.pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown';

export function kindOf(file: File): DocKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'md';
  if (name.endsWith('.txt') || file.type.startsWith('text/')) return 'txt';
  return null;
}

export function paragraphsToPage(docId: string, page: number, paras: Paragraph[]): PageRecord {
  return {
    docId,
    page,
    status: 'ready',
    blocks: paras.map((p, i) => makeBlock(page, i, p.text, p.heading, p.small, p.margin)),
  };
}

const stripExt = (name: string) => name.replace(/\.[^.]+$/, '');

/** Import a file into the library. Scanned PDF pages are stored as
 * `ocr-pending` and picked up by the OCR runner. */
export async function importFile(file: File, onProgress?: (msg: string) => void): Promise<DocRecord> {
  const kind = kindOf(file);
  if (!kind) throw new Error(`Unsupported file type: ${file.name}`);
  const id = newId();
  const now = Date.now();
  let pages: PageRecord[];
  let title = stripExt(file.name);

  if (kind === 'pdf') {
    const pdf = await extractPdf(file, (d, t) => onProgress?.(`Reading page ${d} of ${t}…`));
    // Only trust PDF metadata titles that look like real titles.
    if (pdf.title && pdf.title.length > 3 && !/^(untitled|microsoft word)/i.test(pdf.title)) title = pdf.title;
    pages = pdf.pages.map((paras, i) =>
      paras ? paragraphsToPage(id, i + 1, paras) : { docId: id, page: i + 1, status: 'ocr-pending', blocks: [] },
    );
  } else {
    const raw = await file.text();
    const paras = kind === 'md' ? markdownToParagraphs(raw) : textToParagraphs(raw);
    pages = [paragraphsToPage(id, 1, paras)];
  }

  const doc: DocRecord = {
    id,
    title,
    kind,
    fileName: file.name,
    createdAt: now,
    openedAt: now,
    pageCount: pages.length,
    ocrPending: pages.filter((p) => p.status === 'ocr-pending').length,
    progress: 0,
  };
  await db.transaction('rw', [db.docs, db.pages, db.files], async () => {
    await db.docs.add(doc);
    await db.pages.bulkAdd(pages);
    if (kind === 'pdf') await db.files.add({ docId: id, blob: file });
  });
  return doc;
}

/**
 * Re-run text extraction on a PDF already in the library (e.g. after parsing
 * improvements). Pages that were converted with OCR keep their text.
 * Highlights are kept but may shift slightly if paragraph breaks changed.
 */
export async function reextractPdf(docId: string, onProgress?: (msg: string) => void): Promise<void> {
  const [doc, blob] = await Promise.all([db.docs.get(docId), sync.loadFile(docId)]);
  if (!doc || doc.kind !== 'pdf' || !blob) throw new Error('Original PDF not found for this document.');
  const pdf = await extractPdf(blob, (d, t) => onProgress?.(`Reading page ${d} of ${t}…`));
  const old = new Map((await db.pages.where('docId').equals(docId).toArray()).map((p) => [p.page, p]));
  const pages: PageRecord[] = pdf.pages.map((paras, i) => {
    const n = i + 1;
    if (paras) return paragraphsToPage(docId, n, paras);
    const prev = old.get(n);
    // Scanned page: keep earlier OCR text if there is any.
    return prev && prev.blocks.length ? prev : { docId, page: n, status: 'ocr-pending', blocks: [] };
  });
  await db.transaction('rw', [db.docs, db.pages], async () => {
    await db.pages.where('docId').equals(docId).delete();
    await db.pages.bulkAdd(pages);
    await db.docs.update(docId, { pageCount: pages.length, ocrPending: pages.filter((p) => p.status === 'ocr-pending').length });
  });
}

/** Replace one paragraph's text (e.g. fixing an OCR mistake). */
export async function updateBlockText(docId: string, blockId: string, text: string): Promise<void> {
  const [page, index] = blockId.split('-').map(Number);
  await db.transaction('rw', db.pages, async () => {
    const rec = await db.pages.get([docId, page]);
    if (!rec) return;
    const blocks = rec.blocks.map((b) => {
      if (b.id !== blockId) return b;
      const nb = makeBlock(page, index, text.replace(/\s+/g, ' ').trim(), b.heading, b.small, b.margin);
      nb.id = b.id;
      nb.edited = true;
      return nb;
    });
    await db.pages.update([docId, page], { blocks });
  });
}

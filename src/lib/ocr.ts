import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { RecognizeResult, Worker as TesseractWorker } from 'tesseract.js';
import { db } from './db';
import { paragraphsToPage } from './importer';
import { openPdf, renderPage } from './pdf';
import { linesToParagraphs, type Line } from './pdfLayout';
import { isPageNumber, textToParagraphs, type Paragraph } from './textImport';

/** Lines Tesseract is less sure about than this are usually noise from figures. */
const MIN_LINE_CONFIDENCE = 40;

/** Turn Tesseract output into paragraphs using line positions, the same way
 * as text-based PDFs. Falls back to Tesseract's plain text. */
export function ocrToParagraphs(data: RecognizeResult['data']): Paragraph[] {
  const lines: Line[] = [];
  for (const block of data.blocks ?? []) {
    let first = true;
    for (const para of block.paragraphs)
      for (const l of para.lines) {
        const text = l.text.trim();
        if (!text || l.confidence < MIN_LINE_CONFIDENCE || !/\p{L}/u.test(text) || isPageNumber(text)) continue;
        const row = l.rowAttributes as { rowHeight?: number; row_height?: number } | undefined;
        const h = row?.rowHeight || row?.row_height || l.bbox.y1 - l.bbox.y0;
        lines.push({
          text,
          x: l.bbox.x0,
          // flip so y grows upward like PDF coordinates
          y: -(l.baseline ? (l.baseline.y0 + l.baseline.y1) / 2 : l.bbox.y1),
          w: l.bbox.x1 - l.bbox.x0,
          h,
          breakBefore: first,
        });
        first = false;
      }
  }
  if (!lines.length) return textToParagraphs(data.text ?? '').filter((p) => !isPageNumber(p.text));
  return linesToParagraphs(lines);
}

type Listener = (s: OcrStatus) => void;

export interface OcrStatus {
  running: boolean;
  docId?: string;
  page?: number;
  error?: string;
}

/** Background OCR for scanned PDF pages. One page at a time, starting near
 * where the user is reading. Results are saved, so each page is done once. */
class OcrRunner {
  private worker: Promise<TesseractWorker> | null = null;
  private pdfCache: { docId: string; pdf: PDFDocumentProxy } | null = null;
  private focus: { docId: string; page: number } | null = null;
  private running = false;
  private status: OcrStatus = { running: false };
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(this.status);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private set(s: OcrStatus) {
    this.status = s;
    this.listeners.forEach((l) => l(s));
  }

  /** Prefer pages of this document at or after `page`. */
  setFocus(docId: string, page: number) {
    this.focus = { docId, page };
    this.kick();
  }

  kick() {
    if (!this.running) void this.loop();
  }

  async retry(docId: string, page: number) {
    await db.pages.update([docId, page], { status: 'ocr-pending' });
    await this.recount(docId);
    this.kick();
  }

  private async next(): Promise<{ docId: string; page: number } | null> {
    const pending = await db.pages.where('status').equals('ocr-pending').toArray();
    if (!pending.length) return null;
    const f = this.focus;
    if (f) {
      const mine = pending.filter((p) => p.docId === f.docId).sort((a, b) => a.page - b.page);
      const pick = mine.find((p) => p.page >= f.page) ?? mine[0];
      if (pick) return { docId: pick.docId, page: pick.page };
    }
    pending.sort((a, b) => a.page - b.page);
    return { docId: pending[0].docId, page: pending[0].page };
  }

  private async getWorker(): Promise<TesseractWorker> {
    if (!this.worker) {
      // Engine and language data are self-hosted (see scripts/copy-ocr-assets.mjs).
      const base = new URL(`${import.meta.env.BASE_URL}ocr/`, window.location.href).href;
      this.worker = import('tesseract.js').then(({ createWorker }) =>
        createWorker('eng', 1, {
          workerPath: `${base}worker.min.js`,
          corePath: `${base}core`,
          langPath: `${base}lang`,
          gzip: true,
        }),
      );
      this.worker.catch(() => (this.worker = null));
    }
    return this.worker;
  }

  private async getPdf(docId: string): Promise<PDFDocumentProxy | null> {
    if (this.pdfCache?.docId === docId) return this.pdfCache.pdf;
    const file = await db.files.get(docId);
    if (!file) return null;
    if (this.pdfCache) await this.pdfCache.pdf.destroy();
    const pdf = await openPdf(file.blob);
    this.pdfCache = { docId, pdf };
    return pdf;
  }

  private async recount(docId: string) {
    const n = await db.pages.where('[docId+page]').between([docId, 0], [docId, Infinity]).filter((p) => p.status === 'ocr-pending').count();
    await db.docs.update(docId, { ocrPending: n });
  }

  private async loop() {
    this.running = true;
    try {
      for (let job = await this.next(); job; job = await this.next()) {
        const { docId, page } = job;
        this.set({ running: true, docId, page });
        let worker: TesseractWorker;
        try {
          worker = await this.getWorker();
        } catch (err) {
          // Usually: no internet for the first download of the OCR engine. Leave pages pending.
          console.error('OCR engine failed to load', err);
          this.set({ running: false, error: 'Could not load the OCR engine (needs internet the first time).' });
          return;
        }
        try {
          const pdf = await this.getPdf(docId);
          if (!pdf) {
            await db.pages.update([docId, page], { status: 'ocr-failed' });
            continue;
          }
          const canvas = await renderPage(pdf, page);
          const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
          canvas.width = canvas.height = 0;
          const paras = ocrToParagraphs(data);
          const rec = paragraphsToPage(docId, page, paras);
          // Document may have been deleted meanwhile.
          if (await db.docs.get(docId)) await db.pages.put(rec);
        } catch (err) {
          console.error('OCR failed', docId, page, err);
          await db.pages.update([docId, page], { status: 'ocr-failed' });
        } finally {
          if (await db.docs.get(docId)) await this.recount(docId);
        }
      }
      this.set({ running: false });
    } finally {
      this.running = false;
    }
  }
}

export const ocr = new OcrRunner();

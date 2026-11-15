import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { linesToParagraphs, markHeadersFooters, markMarginBand, runsToLines, type Line, type TextRun } from './pdfLayout';
import type { Paragraph } from './textImport';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Pages with less text than this are treated as scanned images and sent to OCR. */
const MIN_TEXT_CHARS = 25;

export async function openPdf(data: ArrayBuffer | Blob): Promise<PDFDocumentProxy> {
  const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data.slice(0));
  return getDocument({ data: bytes }).promise;
}

export interface ExtractedPdf {
  title?: string;
  pageCount: number;
  /** null = no usable text layer (needs OCR) */
  pages: (Paragraph[] | null)[];
}

export async function extractPdf(
  data: Blob,
  onProgress?: (done: number, total: number) => void,
): Promise<ExtractedPdf> {
  const pdf = await openPdf(data);
  try {
    const pageLines: Line[][] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const runs: TextRun[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const [a, b, c, d, x, y] = item.transform as number[];
        // Sideways/diagonal/mirrored text is almost always a watermark or margin
        // stamp (e.g. arXiv's vertical ID), not body text.
        if (Math.abs(b) > Math.abs(a) * 0.05 || Math.abs(c) > Math.abs(d) * 0.05 || a <= 0 || d <= 0) continue;
        runs.push({
          str: item.str,
          x,
          y,
          w: item.width,
          h: item.height || Math.hypot(a, b),
          eol: item.hasEOL,
        });
      }
      const [, y0, , y1] = page.view;
      pageLines.push(markMarginBand(runsToLines(runs), y0, y1));
      page.cleanup();
      onProgress?.(n, pdf.numPages);
    }
    const cleaned = markHeadersFooters(pageLines);
    // Judge "scanned" on body text only: scans often carry a text footer
    // ("Downloaded from … on …") stamped over the page image.
    const scanned = cleaned.map((lines) => lines.reduce((s, l) => s + (l.margin ? 0 : l.text.length), 0) < MIN_TEXT_CHARS);
    let title: string | undefined;
    try {
      const meta = await pdf.getMetadata();
      const t = (meta.info as { Title?: string } | undefined)?.Title?.trim();
      if (t) title = t;
    } catch {
      /* no metadata */
    }
    return {
      title,
      pageCount: pdf.numPages,
      pages: cleaned.map((lines, i) => (scanned[i] ? null : linesToParagraphs(lines))),
    };
  } finally {
    await pdf.destroy();
  }
}

/** Render one page to a canvas, about `targetWidth` pixels wide. */
export async function renderPage(pdf: PDFDocumentProxy, n: number, targetWidth = 2000): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(4, Math.max(1.5, targetWidth / base.width));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
  return canvas;
}

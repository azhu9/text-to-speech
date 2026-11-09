import { isPageNumber, joinLines, type Paragraph } from './textImport';

/** A positioned run of text from the PDF text layer (PDF units, y grows upward). */
export interface TextRun {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  eol: boolean;
}

export interface Line {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** force a paragraph break before this line (e.g. new OCR text block) */
  breakBefore?: boolean;
}

/** Group runs into lines, keeping the PDF's content order (which usually
 * follows columns correctly). */
export function runsToLines(runs: TextRun[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  const push = () => {
    if (cur && cur.text.trim()) lines.push({ ...cur, text: cur.text.replace(/\s+/g, ' ').trim() });
    cur = null;
  };
  for (const r of runs) {
    if (r.str) {
      if (!cur) {
        cur = { text: r.str, x: r.x, y: r.y, w: r.w, h: r.h };
      } else if (Math.abs(r.y - cur.y) > Math.max(cur.h, r.h, 1) * 0.6 || r.x < cur.x + cur.w - Math.max(cur.h, 1) * 2) {
        push();
        cur = { text: r.str, x: r.x, y: r.y, w: r.w, h: r.h };
      } else {
        const gap = r.x - (cur.x + cur.w);
        const needSpace = gap > Math.max(r.h, 1) * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(r.str);
        cur.text += (needSpace ? ' ' : '') + r.str;
        const right = Math.max(cur.x + cur.w, r.x + r.w);
        cur.w = right - cur.x;
        cur.h = Math.max(cur.h, r.h);
      }
    }
    if (r.eol) push();
  }
  push();
  return lines;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const normalizeForRepeat = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/** Drop running headers/footers and page numbers: lines near the top or bottom of
 * a page that are page numbers or repeat across many pages. */
export function removeHeadersFooters(pages: Line[][], edge = 2): Line[][] {
  // Edge = among the top-most / bottom-most lines on the page by position (the
  // content stream often draws headers and page numbers first or last).
  // On short pages only the very first/last line counts.
  const edgeSets = pages.map((lines) => {
    const n = lines.length;
    const e = Math.max(1, Math.min(edge, Math.floor((n - 1) / 2)));
    const byY = lines.map((_, i) => i).sort((a, b) => lines[b].y - lines[a].y);
    return new Set([...byY.slice(0, e), ...byY.slice(Math.max(e, n - e))]);
  });
  const counts = new Map<string, number>();
  pages.forEach((lines, p) => {
    const seen = new Set<string>();
    for (const i of edgeSets[p]) {
      const k = normalizeForRepeat(lines[i].text);
      if (!seen.has(k)) {
        seen.add(k);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  });
  const threshold = Math.max(3, Math.ceil(pages.filter((p) => p.length).length * 0.3));
  return pages.map((lines, p) =>
    lines.filter((l, i) => {
      if (!edgeSets[p].has(i)) return true;
      if (isPageNumber(l.text)) return false;
      return (counts.get(normalizeForRepeat(l.text)) ?? 0) < threshold;
    }),
  );
}

/** Group lines into paragraphs using vertical gaps, font-size changes and
 * short last lines. */
export function linesToParagraphs(lines: Line[]): Paragraph[] {
  if (!lines.length) return [];
  const h = median(lines.map((l) => l.h)) || 10;
  const width = median(lines.map((l) => l.w)) || 1;
  const paras: { lines: string[]; h: number }[] = [];
  let cur: { lines: string[]; h: number } | null = null;
  let prev: Line | null = null;
  for (const line of lines) {
    let breakBefore = !prev;
    if (prev && cur) {
      const dy = prev.y - line.y;
      const sizeChange = Math.abs(line.h - prev.h) > Math.max(prev.h, line.h) * 0.2;
      const bigGap = dy > Math.max(prev.h, line.h) * 1.7;
      const jumped = dy < -h * 0.5; // moved up: new column or out-of-order block
      const prevEnded = /[.!?:"”)]$/.test(prev.text);
      const shortPrev = prev.w < width * 0.75;
      const indented = line.x > prev.x + h * 0.8 && prevEnded;
      breakBefore = !!line.breakBefore || sizeChange || bigGap || jumped || (prevEnded && shortPrev) || indented;
    }
    if (breakBefore || !cur) {
      cur = { lines: [], h: line.h };
      paras.push(cur);
    }
    cur.lines.push(line.text);
    prev = line;
  }
  return paras
    .map((p) => {
      const text = joinLines(p.lines);
      const heading = p.h > h * 1.25 && text.length < 150 && !/[.!?]$/.test(text);
      if (heading) return { text, heading };
      return p.h < h * 0.85 ? { text, small: true } : { text };
    })
    .filter((p) => /[\p{L}\p{N}]/u.test(p.text));
}

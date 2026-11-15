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
  /** page furniture: header, footer, page number, margin notice */
  margin?: boolean;
}

/** A small, raised run of digits/symbols right after a word or punctuation. */
function isFootnoteMarker(r: TextRun, cur: Line): boolean {
  return (
    /^[\d*†‡§¶,–-]{1,5}$/.test(r.str.trim()) &&
    r.h > 0 &&
    r.h < cur.h * 0.8 &&
    r.y > cur.y + cur.h * 0.2 &&
    /[\p{L}.,;:!?)"”’]$/u.test(cur.text)
  );
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
      } else if (isFootnoteMarker(r, cur)) {
        // Small raised number after a word ("cells.¹²"): a footnote marker, not something to read.
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

/** Mark running headers/footers and page numbers: lines near the top or bottom
 * of a page that are page numbers or repeat across many pages. Marked lines are
 * kept (shown greyed) but not read when "headers & footers" skipping is on. */
export function markHeadersFooters(pages: Line[][], edge = 2): Line[][] {
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
  const threshold = Math.max(2, Math.ceil(pages.filter((p) => p.length).length * 0.25));
  return pages.map((lines, p) =>
    lines.map((l, i) => {
      if (l.margin || !edgeSets[p].has(i)) return l;
      const furniture = isPageNumber(l.text) || (counts.get(normalizeForRepeat(l.text)) ?? 0) >= threshold;
      return furniture ? { ...l, margin: true } : l;
    }),
  );
}

/** Kept for callers/tests that want the furniture gone entirely. */
export function removeHeadersFooters(pages: Line[][], edge = 2): Line[][] {
  return markHeadersFooters(pages, edge).map((lines) => lines.filter((l) => !l.margin));
}

/**
 * Mark lines sitting in the top/bottom margin of the page (within `band` of the
 * edge) that are set apart from the body: a big gap to the nearest body line,
 * or smaller type. Catches one-off footers like "Distributed by …".
 * `bottom`/`top` are the page edges in the same units as line.y (y grows upward).
 */
export function markMarginBand(lines: Line[], bottom: number, top: number, band = 0.07): Line[] {
  const height = top - bottom;
  if (height <= 0 || lines.length < 2) return lines;
  const inBand = (l: Line) => l.y - bottom < height * band || top - (l.y + l.h) < height * band;
  const body = lines.filter((l) => !inBand(l));
  if (!body.length) return lines;
  const bodyH = median(body.map((l) => l.h)) || 10;
  const bodyTop = Math.max(...body.map((l) => l.y + l.h));
  const bodyBottom = Math.min(...body.map((l) => l.y));
  return lines.map((l) => {
    if (!inBand(l)) return l;
    const gap = l.y > bodyTop ? l.y - bodyTop : bodyBottom - (l.y + l.h);
    const apart = gap > bodyH * 1.5;
    const smaller = l.h < bodyH * 0.9;
    return apart || smaller ? { ...l, margin: true } : l;
  });
}

/** Group lines into paragraphs using vertical gaps, font-size changes and
 * short last lines. */
export function linesToParagraphs(all: Line[]): Paragraph[] {
  // Page furniture is pulled out of the reading flow (so a footer drawn mid-stream
  // can't split a paragraph) and put back as separate paragraphs at the top/bottom.
  const lines = all.filter((l) => !l.margin);
  const margin = all.filter((l) => l.margin);
  const midY = lines.length ? (Math.max(...lines.map((l) => l.y)) + Math.min(...lines.map((l) => l.y))) / 2 : 0;
  const furniture = (ls: Line[]): Paragraph[] =>
    ls.filter((l) => /[\p{L}\p{N}]/u.test(l.text)).map((l) => ({ text: l.text.replace(/\s+/g, ' ').trim(), margin: true }));
  const top = furniture(margin.filter((l) => l.y >= midY).sort((a, b) => b.y - a.y));
  const bottom = furniture(margin.filter((l) => l.y < midY).sort((a, b) => b.y - a.y));
  return [...top, ...bodyParagraphs(lines), ...bottom];
}

function bodyParagraphs(lines: Line[]): Paragraph[] {
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

import { isPageNumber } from './textImport';
import type { Block } from './types';

export interface SkipOptions {
  /** running headers/footers, page numbers, "Distributed by…" notices */
  furniture: boolean;
  /** [12], [3, 5–7], (Smith et al., 2020; Lee 2019) */
  citations: boolean;
  /** web addresses, emails, DOIs */
  urls: boolean;
  /** paragraphs starting "Figure 3.2", "Table 1:" … */
  captions: boolean;
  /** everything under a "References" / "Bibliography" heading */
  references: boolean;
  /** small print at the bottom of PDF pages */
  footnotes: boolean;
}

export const SKIP_LABELS: Record<keyof SkipOptions, string> = {
  furniture: 'Headers, footers & page numbers',
  citations: 'Citations like [12] or (Smith, 2020)',
  urls: 'Web links and emails',
  captions: 'Figure and table captions',
  references: 'Reference lists / bibliography',
  footnotes: 'Footnotes (small print)',
};

export const DEFAULT_SKIP: SkipOptions = { furniture: true, citations: true, urls: true, captions: false, references: true, footnotes: false };

export type Range = [number, number];

const NUMERIC_CITATION = /\[\s*\d+[a-z]?(?:\s*(?:[,;]|[-–—]|and)\s*\d+[a-z]?)*\s*\]/g;
const PARENTHETICAL = /\(([^()]{3,250})\)/g;
const YEAR = /\b(?:1[6-9]\d{2}|20\d{2})[a-z]?\b|\bn\.d\./;
const CITATION_PART = /^(?:(?:see(?: also)?|e\.g\.,?|cf\.|for example,?|i\.e\.,?)\s+)?\p{Lu}[^;]*?(?:\b(?:1[6-9]\d{2}|20\d{2})[a-z]?\b|\bn\.d\.)(?:\s*,\s*(?:pp?\.|p)\s*[\d–-]+)?$/u;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]|\bdoi:\s*\S+[^\s.,;]|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi;

function isCitationParenthetical(inner: string): boolean {
  if (!YEAR.test(inner)) return false;
  return inner.split(/;\s*/).every((part) => CITATION_PART.test(part.trim()));
}

/** Character ranges inside `text` that should not be read aloud. */
export function inlineSkips(text: string, opts: SkipOptions): Range[] {
  const ranges: Range[] = [];
  if (opts.citations) {
    for (const m of text.matchAll(NUMERIC_CITATION)) ranges.push([m.index!, m.index! + m[0].length]);
    for (const m of text.matchAll(PARENTHETICAL)) if (isCitationParenthetical(m[1])) ranges.push([m.index!, m.index! + m[0].length]);
  }
  if (opts.urls) for (const m of text.matchAll(URL)) ranges.push([m.index!, m.index! + m[0].length]);
  if (!ranges.length) return ranges;
  // Swallow the space before a removed piece so "cells [12]." reads "cells."
  const widened = ranges.map(([a, b]): Range => {
    let s = a;
    while (s > 0 && /[ \t]/.test(text[s - 1])) s--;
    return /^[\s.,;:!?)\]]|^$/.test(text.slice(b, b + 1)) ? [s, b] : [a, b];
  });
  widened.sort((x, y) => x[0] - y[0]);
  const merged: Range[] = [];
  for (const r of widened) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

const CAPTION = /^(?:fig(?:ure)?|table|chart|graph|exhibit|plate|scheme|diagram|illustration)\.?\s*[\dIVX]+[\w.\-–]*\s*[.:|)\-–—]?\s/i;
const REFERENCES_HEADING = /^(?:[\dIVX]+\.?\s*)?(?:references|bibliography|works cited|literature cited|sources|reference list|citations)\s*:?$/i;

/** Notices printed on every page of a distributed copy, not part of the text. */
const BOILERPLATE =
  /\b(distributed by|downloaded (from|by|on)|all rights reserved|copyright\s*(©|\(c\)|\d{4})|licen[cs]ed to|for (personal|private|educational|classroom|non-?commercial) use( only)?|not for (re-?)?(distribution|sale|resale)|do not (copy|distribute|reproduce)|(reproduced|reprinted) (with|by) permission|terms (of use|and conditions)|this content downloaded|persistent link|uploaded by|creative commons)\b|©|\(c\)\s*\d{4}/i;
/** A short line that is mostly a link (source URL stamped on each page). */
const LINK_LINE = /https?:\/\/|www\.|doi\.org|doi:/i;

/** Letter pairs of the text, ignoring digits, spaces and punctuation, so
 * page numbers and OCR slips ("BI0LOGY") barely matter. */
function bigrams(s: string): Map<string, number> {
  const t = s.toLowerCase().replace(/[^\p{L}]+/gu, '');
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function bigramCount(m: Map<string, number>): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

/** Dice similarity of letter pairs (0..1). */
function similar(a: Map<string, number>, b: Map<string, number>): boolean {
  const na = bigramCount(a);
  const nb = bigramCount(b);
  if (na < 3 || nb < 3) return false;
  let shared = 0;
  for (const [g, c] of a) shared += Math.min(c, b.get(g) ?? 0);
  return (2 * shared) / (na + nb) >= 0.8;
}

/**
 * Page furniture found at read time, so it also works for scanned pages and
 * documents imported before import-time marking existed: blocks at the top or
 * bottom of a page that are page numbers, distribution notices, or repeat
 * (allowing OCR typos) on several pages.
 */
export function furnitureBlocks(blocks: Block[]): Set<string> {
  const out = new Set<string>();
  const byPage = new Map<number, Block[]>();
  for (const b of blocks) {
    if (b.margin) out.add(b.id);
    const list = byPage.get(b.page) ?? [];
    list.push(b);
    byPage.set(b.page, list);
  }
  const edges: { b: Block; page: number; toks: Map<string, number> }[] = [];
  for (const [page, list] of [...byPage].sort((a, b) => a[0] - b[0])) {
    const n = list.length;
    const e = n <= 3 ? 1 : 2;
    list.forEach((b, i) => {
      if (i >= e && i < n - e) return;
      const text = b.text.trim();
      if (text.length > 220) return;
      if (isPageNumber(text) || BOILERPLATE.test(text) || (text.length < 100 && LINK_LINE.test(text))) out.add(b.id);
      else if (!b.heading) edges.push({ b, page, toks: bigrams(text) });
    });
  }
  const pagesWithText = byPage.size;
  if (pagesWithText < 2) return out;
  const threshold = Math.max(2, Math.ceil(pagesWithText * 0.2));

  // Link similar edge blocks into groups (union-find). Running headers repeat
  // on nearby pages, so fuzzy matching only looks a few pages ahead; exact
  // matches (ignoring digits/punctuation) link across the whole document.
  const parent = edges.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const exact = new Map<string, number>();
  edges.forEach((e, i) => {
    const key = e.b.text.toLowerCase().replace(/[^\p{L}]+/gu, '');
    if (key.length < 3) return;
    const j = exact.get(key);
    if (j === undefined) exact.set(key, i);
    else union(i, j);
  });
  const LOOK_AHEAD_PAGES = 3;
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length && edges[j].page <= edges[i].page + LOOK_AHEAD_PAGES; j++)
      if (edges[j].page !== edges[i].page && find(i) !== find(j) && similar(edges[i].toks, edges[j].toks)) union(i, j);

  const groupPages = new Map<number, Set<number>>();
  edges.forEach((e, i) => {
    const r = find(i);
    const set = groupPages.get(r) ?? new Set<number>();
    set.add(e.page);
    groupPages.set(r, set);
  });
  edges.forEach((e, i) => {
    if ((groupPages.get(find(i))?.size ?? 0) >= threshold) out.add(e.b.id);
  });
  return out;
}

/** Blocks to leave out entirely. */
export function skippedBlocks(blocks: Block[], opts: SkipOptions): Set<string> {
  const out = opts.furniture ? furnitureBlocks(blocks) : new Set<string>();
  let inReferences = false;
  for (const b of blocks) {
    const text = b.text.trim();
    const headingLike = b.heading || (text.length < 40 && !/[.!?]$/.test(text));
    if (opts.references) {
      if (REFERENCES_HEADING.test(text)) inReferences = true;
      else if (inReferences && b.heading) inReferences = false; // next section starts
    }
    if (inReferences && opts.references) out.add(b.id);
    else if (opts.captions && CAPTION.test(text + ' ') && !headingLike) out.add(b.id);
    else if (opts.footnotes && b.small) out.add(b.id);
  }
  return out;
}

export interface SpokenText {
  /** text with skipped parts removed */
  speak: string;
  /** map[i] = index in the original text of speak[i]; map[speak.length] = end */
  map: number[];
}

/** Remove `ranges` (relative to `text`) and keep a map back to original offsets. */
export function applySkips(text: string, ranges: Range[]): SpokenText {
  let speak = '';
  const map: number[] = [];
  let r = 0;
  for (let i = 0; i < text.length; i++) {
    while (r < ranges.length && ranges[r][1] <= i) r++;
    if (r < ranges.length && ranges[r][0] <= i && i < ranges[r][1]) continue;
    speak += text[i];
    map.push(i);
  }
  map.push(text.length);
  // Trim whitespace left at either end by a removed piece, keeping map aligned.
  let a = 0;
  let b = speak.length;
  while (a < b && /\s/.test(speak[a])) a++;
  while (b > a && /\s/.test(speak[b - 1])) b--;
  if (a === 0 && b === speak.length) return { speak, map };
  return { speak: speak.slice(a, b), map: [...map.slice(a, b), b < speak.length ? map[b] : map[speak.length]] };
}

const SKIP_KEY = 'read-aloud:skip';

export function loadSkipOptions(): SkipOptions {
  try {
    return { ...DEFAULT_SKIP, ...JSON.parse(localStorage.getItem(SKIP_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_SKIP };
  }
}

export function saveSkipOptions(o: SkipOptions) {
  try {
    localStorage.setItem(SKIP_KEY, JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

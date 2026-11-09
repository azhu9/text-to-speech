import type { Block } from './types';

export interface SkipOptions {
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
  citations: 'Citations like [12] or (Smith, 2020)',
  urls: 'Web links and emails',
  captions: 'Figure and table captions',
  references: 'Reference lists / bibliography',
  footnotes: 'Footnotes (small print)',
};

export const DEFAULT_SKIP: SkipOptions = { citations: true, urls: true, captions: false, references: true, footnotes: false };

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

/** Blocks to leave out entirely. */
export function skippedBlocks(blocks: Block[], opts: SkipOptions): Set<string> {
  const out = new Set<string>();
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

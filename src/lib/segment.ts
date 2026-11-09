import type { Block, Sentence } from './types';

/** Longest chunk we hand to the speech engine in one go. Long utterances
 * are unreliable in Chrome (they can stop after ~15 s). */
export const MAX_CHUNK = 240;

const HAS_WORD = /[\p{L}\p{N}]/u;

function rawSentences(text: string): Sentence[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
    return [...seg.segment(text)].map((s) => [s.index, s.index + s.segment.length]);
  }
  const out: Sentence[] = [];
  const re = /[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m[0].length) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Split [start, end) into pieces of at most `max` chars, preferring to break
 * after punctuation, then at whitespace. */
function splitLong(text: string, start: number, end: number, max: number): Sentence[] {
  const out: Sentence[] = [];
  let s = start;
  while (end - s > max) {
    const window = text.slice(s, s + max);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    let pieceEnd: number;
    if (cut <= 0) pieceEnd = s + max;
    else pieceEnd = s + cut + (window[cut] === ' ' ? 0 : 1);
    out.push([s, pieceEnd]);
    s = pieceEnd;
    while (s < end && /\s/.test(text[s])) s++;
  }
  if (s < end) out.push([s, end]);
  return out;
}

/** Sentences of `text` as trimmed [start, end) ranges, long ones split into chunks. */
export function splitSentences(text: string, max = MAX_CHUNK): Sentence[] {
  const out: Sentence[] = [];
  for (let [a, b] of rawSentences(text)) {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b <= a || !HAS_WORD.test(text.slice(a, b))) continue;
    out.push(...splitLong(text, a, b, max));
  }
  return out;
}

export function makeBlock(page: number, index: number, text: string, heading = false, small = false): Block {
  const block: Block = { id: `${page}-${index}`, page, text, sentences: splitSentences(text) };
  if (heading) block.heading = true;
  if (small) block.small = true;
  return block;
}

/** Parse "page-index" block ids for ordering. */
export function blockOrder(id: string): [number, number] {
  const [p, i] = id.split('-').map(Number);
  return [p, i];
}

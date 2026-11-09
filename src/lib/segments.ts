import type { Annotation, Block } from './types';

export interface Segment {
  start: number;
  end: number;
  /** index of the sentence this segment belongs to, -1 for gaps between sentences */
  sentence: number;
  annotations: Annotation[];
  word: boolean;
  /** not read aloud (skip settings) */
  skipped: boolean;
}

/** Split a block's text at every sentence, highlight and current-word boundary,
 * so each piece can be rendered as one span with the right styles. */
export function buildSegments(
  block: Block,
  annotations: Annotation[],
  word: [number, number] | null,
  skips: [number, number][] = [],
): Segment[] {
  const len = block.text.length;
  const points = new Set<number>([0, len]);
  for (const [s, e] of block.sentences) points.add(s).add(e);
  const ranges: { a: Annotation; start: number; end: number }[] = [];
  for (const a of annotations)
    for (const r of a.ranges)
      if (r.blockId === block.id) {
        const start = Math.max(0, Math.min(len, r.start));
        const end = Math.max(0, Math.min(len, r.end));
        if (end > start) {
          ranges.push({ a, start, end });
          points.add(start).add(end);
        }
      }
  for (const [a, b] of skips) points.add(Math.max(0, Math.min(len, a))).add(Math.max(0, Math.min(len, b)));
  if (word) points.add(Math.max(0, Math.min(len, word[0]))).add(Math.max(0, Math.min(len, word[1])));
  const sorted = [...points].sort((x, y) => x - y);
  const out: Segment[] = [];
  let si = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (end <= start) continue;
    while (si < block.sentences.length && block.sentences[si][1] <= start) si++;
    const s = block.sentences[si];
    const sentence = s && s[0] <= start && start < s[1] ? si : -1;
    out.push({
      start,
      end,
      sentence,
      annotations: ranges.filter((r) => r.start <= start && end <= r.end).map((r) => r.a),
      word: !!word && word[0] <= start && end <= word[1],
      skipped: skips.some(([a, b]) => a <= start && end <= b),
    });
  }
  return out;
}

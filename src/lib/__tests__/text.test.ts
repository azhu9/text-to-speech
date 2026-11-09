import { describe, expect, it } from 'vitest';
import { splitSentences } from '../segment';
import { buildSegments } from '../segments';
import { markdownToParagraphs, textToParagraphs } from '../textImport';
import { linesToParagraphs, removeHeadersFooters, runsToLines, type Line } from '../pdfLayout';
import { makeBlock } from '../segment';
import type { Annotation } from '../types';

describe('splitSentences', () => {
  it('splits and trims sentences', () => {
    const t = 'Hello there.  How are you? Fine!';
    expect(splitSentences(t).map(([a, b]) => t.slice(a, b))).toEqual(['Hello there.', 'How are you?', 'Fine!']);
  });
  it('breaks very long sentences into chunks within the limit', () => {
    const t = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ') + '.';
    const parts = splitSentences(t, 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const [a, b] of parts) expect(b - a).toBeLessThanOrEqual(100);
    expect(parts.map(([a, b]) => t.slice(a, b)).join(' ')).toBe(t);
  });
  it('skips punctuation-only pieces', () => {
    expect(splitSentences('... ')).toEqual([]);
  });
});

describe('textToParagraphs', () => {
  it('joins wrapped lines and removes hyphenation', () => {
    const raw = 'The infor-\nmation was\nwrapped.\n\nSecond para.\r\n';
    expect(textToParagraphs(raw).map((p) => p.text)).toEqual(['The information was wrapped.', 'Second para.']);
  });
  it('keeps real hyphenated words before capitals', () => {
    expect(textToParagraphs('Self-\nAware')[0].text).toBe('Self- Aware');
  });
});

describe('markdownToParagraphs', () => {
  it('strips markup and marks headings', () => {
    const md = '# Title\n\nSome **bold** and [a link](http://x).\n\n- item one\n- item two\n';
    expect(markdownToParagraphs(md)).toEqual([
      { text: 'Title', heading: true },
      { text: 'Some bold and a link.' },
      { text: 'item one' },
      { text: 'item two' },
    ]);
  });
});

const line = (text: string, y: number, extra: Partial<Line> = {}): Line => ({ text, x: 72, y, w: 450, h: 10, ...extra });

describe('PDF layout', () => {
  it('groups runs into lines and adds missing spaces', () => {
    const lines = runsToLines([
      { str: 'Hello', x: 0, y: 700, w: 25, h: 10, eol: false },
      { str: 'world', x: 28, y: 700, w: 25, h: 10, eol: true },
      { str: 'Next line', x: 0, y: 688, w: 45, h: 10, eol: true },
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Hello world', 'Next line']);
  });

  it('builds paragraphs from gaps and short last lines', () => {
    const paras = linesToParagraphs([
      line('Chapter One', 740, { h: 18, w: 120 }),
      line('This is the first line of a para-', 700),
      line('graph that continues here and', 688),
      line('ends here.', 676, { w: 60 }),
      line('A new paragraph starts.', 664),
    ]);
    expect(paras).toEqual([
      { text: 'Chapter One', heading: true },
      { text: 'This is the first line of a paragraph that continues here and ends here.' },
      { text: 'A new paragraph starts.' },
    ]);
  });

  it('removes repeated headers and page numbers', () => {
    const pages = [1, 2, 3, 4].map((n) => [line('Journal of Things, Vol 3', 780), line(`Body text on page ${n}.`, 700), line(String(n), 40)]);
    expect(removeHeadersFooters(pages).map((p) => p.map((l) => l.text))).toEqual(
      [1, 2, 3, 4].map((n) => [`Body text on page ${n}.`]),
    );
  });
});

describe('buildSegments', () => {
  it('splits at sentences, highlights and the current word', () => {
    const block = makeBlock(1, 0, 'One two. Three four.');
    const ann: Annotation = {
      id: 'a',
      docId: 'd',
      ranges: [{ blockId: '1-0', start: 4, end: 14 }],
      quote: 'two. Three',
      color: 'yellow',
      note: '',
      createdAt: 0,
      updatedAt: 0,
    };
    const segs = buildSegments(block, [ann], [9, 14]);
    expect(segs.map((s) => block.text.slice(s.start, s.end))).toEqual(['One ', 'two.', ' ', 'Three', ' four.']);
    expect(segs.map((s) => s.sentence)).toEqual([0, 0, -1, 1, 1]);
    expect(segs.map((s) => s.annotations.length)).toEqual([0, 1, 1, 1, 0]);
    expect(segs.map((s) => s.word)).toEqual([false, false, false, true, false]);
    expect(segs.map((s) => block.text.slice(s.start, s.end)).join('')).toBe(block.text);
  });
});

describe('removeHeadersFooters ordering', () => {
  it('uses position on the page, not content order', () => {
    // Page number and header drawn first in the content stream, body after.
    const pages = ['alpha', 'beta', 'gamma'].map((w, n) => [
      line('Course Reader', 780),
      line(String(n + 1), 40),
      line(`Body ${w} first line.`, 700),
      line('Shared sentence in the middle of every page.', 686),
      line(`Body ${w} third line.`, 672),
      line(`Body ${w} last line.`, 658),
    ]);
    expect(removeHeadersFooters(pages)[0].map((l) => l.text)).toEqual([
      'Body alpha first line.',
      'Shared sentence in the middle of every page.',
      'Body alpha third line.',
      'Body alpha last line.',
    ]);
  });
});

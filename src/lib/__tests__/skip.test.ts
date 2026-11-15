import { describe, expect, it } from 'vitest';
import { estimateWordTimings } from '../engines/kokoro';
import { buildItems } from '../player';
import { makeBlock } from '../segment';
import { applySkips, DEFAULT_SKIP, inlineSkips, skippedBlocks, type SkipOptions } from '../skip';

const ALL: SkipOptions = { furniture: true, citations: true, urls: true, captions: true, references: true, footnotes: true };
const NONE: SkipOptions = { furniture: false, citations: false, urls: false, captions: false, references: false, footnotes: false };

const spoken = (text: string, o: SkipOptions = ALL) => applySkips(text, inlineSkips(text, o)).speak;

describe('inline skips', () => {
  it('removes numeric citations without leaving stray spaces', () => {
    expect(spoken('Plants make sugar [12]. Cells divide [3, 5–7] quickly.')).toBe('Plants make sugar. Cells divide quickly.');
  });
  it('removes author-year citations but keeps ordinary parentheses', () => {
    expect(spoken('This is well known (Smith et al., 2020; Lee 2019). It grows (slowly) in spring (see Fig. 2).')).toBe(
      'This is well known. It grows (slowly) in spring (see Fig. 2).',
    );
    expect(spoken('The war ended (in 1945) after years.')).toBe('The war ended (in 1945) after years.');
  });
  it('removes links and emails', () => {
    expect(spoken('Visit https://example.com/page?x=1 or write to a.b@uni.edu for details.')).toBe('Visit or write to for details.');
  });
  it('does nothing when disabled', () => {
    const t = 'Text [1] (Smith, 2020) https://x.org.';
    expect(spoken(t, NONE)).toBe(t);
  });
});

describe('applySkips', () => {
  it('maps spoken offsets back to the original text', () => {
    const text = 'ab [1] cd';
    const { speak, map } = applySkips(text, inlineSkips(text, ALL));
    expect(speak).toBe('ab cd');
    expect(text[map[speak.indexOf('c')]]).toBe('c');
    expect(map[speak.length]).toBe(text.length);
  });
});

describe('skippedBlocks', () => {
  const blocks = [
    makeBlock(1, 0, 'Results', true),
    makeBlock(1, 1, 'Figure 2.1: Growth of plants over time.'),
    makeBlock(1, 2, 'Plants grew a lot.'),
    makeBlock(1, 3, 'A footnote in small print.', false, true),
    makeBlock(2, 0, 'References', true),
    makeBlock(2, 1, 'Smith, J. (2020). Plants. Journal.'),
    makeBlock(2, 2, 'Appendix', true),
    makeBlock(2, 3, 'More text.'),
  ];
  it('skips captions, footnotes and the reference list', () => {
    expect([...skippedBlocks(blocks, ALL)]).toEqual(['1-1', '1-3', '2-0', '2-1']);
  });
  it('respects defaults (captions and footnotes kept)', () => {
    expect([...skippedBlocks(blocks, DEFAULT_SKIP)]).toEqual(['2-0', '2-1']);
  });
  it('buildItems leaves out skipped blocks and citation-only sentences', () => {
    const items = buildItems([makeBlock(1, 0, 'Fact one [1]. [2] Fact two.'), ...blocks.slice(4)], ALL);
    expect(items.map((i) => i.speak)).toEqual(['Fact one.', 'Fact two.', 'Appendix', 'More text.']);
    expect(items[2].heading).toBe(true);
  });
});

describe('estimateWordTimings', () => {
  it('starts at 0, increases, and gives pauses at punctuation', () => {
    const t = estimateWordTimings('Hello there, world. Bye');
    expect(t.map(([s, l]) => [s, l])).toEqual([[0, 5], [6, 6], [13, 6], [20, 3]]);
    expect(t[0][2]).toBe(0);
    for (let i = 1; i < t.length; i++) expect(t[i][2]).toBeGreaterThan(t[i - 1][2]);
    // "world." is followed by a sentence pause, so "Bye" starts late.
    expect(t[3][2] - t[2][2]).toBeGreaterThan(t[1][2] - t[0][2]);
  });
});

describe('headers, footers and notices', () => {
  const page = (p: number, texts: string[]) => texts.map((t, i) => makeBlock(p, i, t));
  const only = (o: Partial<SkipOptions>): SkipOptions => ({ ...NONE, ...o });

  it('skips running headers repeated across pages, even with OCR typos', () => {
    const blocks = [
      ...page(1, ['CHAPTER 3 CELL BIOLOGY 45', 'Cells are the basic unit of life. They were first seen in 1665.', 'Each cell has a membrane.']),
      ...page(2, ['CHAPTER 3 CELL BI0LOGY 46', 'Mitochondria make energy for the cell.', 'Ribosomes make proteins.']),
      ...page(3, ['CHAPTER 3 CELL BIOLOGY 47', 'The nucleus holds DNA.', 'It is surrounded by an envelope.']),
    ];
    expect([...skippedBlocks(blocks, only({ furniture: true }))].sort()).toEqual(['1-0', '2-0', '3-0']);
  });

  it('skips one-off distribution notices and page numbers at page edges', () => {
    const blocks = [
      ...page(1, ['Introduction to the topic starts here and goes on.', 'More body text in the middle of page one.', 'Distributed by XYZ Course Packs. Not for resale.']),
      ...page(2, ['Page 2 of 10', 'Body text continues on page two with more ideas.', 'This content downloaded from 1.2.3.4 on Mon, 01 Jan 2024']),
    ];
    expect([...skippedBlocks(blocks, only({ furniture: true }))].sort()).toEqual(['1-2', '2-0', '2-2']);
  });

  it('keeps body text that merely mentions similar words, and blocks marked at import are skipped', () => {
    const body = makeBlock(1, 0, 'The library provided by the city was printed in 1900 and has a copyright section.');
    const marked = makeBlock(1, 1, 'Some Journal Name', false, false, true);
    const tail = makeBlock(1, 2, 'Final sentence of the page about something else.');
    expect([...skippedBlocks([body, marked, tail], only({ furniture: true }))]).toEqual(['1-1']);
    expect([...skippedBlocks([body, marked, tail], NONE)]).toEqual([]);
  });
});

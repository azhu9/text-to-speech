import { describe, expect, it } from 'vitest';
import { buildItems } from '../player';
import { applyPronunciations } from '../pronounce';
import { makeBlock } from '../segment';
import { applySkips, applyUserRules } from '../skip';

describe('applyUserRules', () => {
  const blocks = [
    makeBlock(1, 0, 'Course pack prepared for BIO 101, Fall term.'),
    makeBlock(1, 1, 'Real content about cells and energy.'),
    makeBlock(2, 0, 'Course pack prepared for BIO 101, Fall term!'),
    makeBlock(2, 1, 'More real content about proteins.'),
  ];
  it('skips single paragraphs and un-skips automatic ones', () => {
    const out = applyUserRules(blocks, new Set(['2-1']), { skip: ['1-1'], read: ['2-1'] });
    expect([...out].sort()).toEqual(['1-1']);
  });
  it('skips every paragraph similar to a pattern, per document or globally', () => {
    expect([...applyUserRules(blocks, new Set(), { patterns: ['Course pack prepared for BIO 101, Fall term.'] })].sort()).toEqual(['1-0', '2-0']);
    expect([...applyUserRules(blocks, new Set(), undefined, ['course pack prepared for bio 202 fall term'])].sort()).toEqual(['1-0', '2-0']);
  });
  it('an explicit "read this" beats a pattern', () => {
    expect([...applyUserRules(blocks, new Set(), { patterns: ['Course pack prepared for BIO 101'], read: ['2-0'] })]).toEqual(['1-0']);
  });
});

describe('applyPronunciations', () => {
  const list = [
    { id: '1', from: 'ATP', to: 'A T P', caseSensitive: true },
    { id: '2', from: 'Hooke', to: 'hook' },
    { id: '3', from: 'New York', to: 'New Yawk' },
  ];
  it('replaces whole words and keeps a map to the original text', () => {
    const text = 'ATP and atp. Hooke lived in New York, not Hookes.';
    const r = applyPronunciations(applySkips(text, []), list);
    expect(r.speak).toBe('A T P and atp. hook lived in New Yawk, not Hookes.');
    expect(r.map.length).toBe(r.speak.length + 1);
    // "and" still maps to "and"
    const i = r.speak.indexOf('and');
    expect(text.slice(r.map[i], r.map[i + 2] + 1)).toBe('and');
    // the replacement maps inside the original word
    const h = r.speak.indexOf('hook');
    expect(text.slice(r.map[h], r.map[h + 3] + 1)).toBe('Hooke'.slice(0, r.map[h + 3] + 1 - r.map[h]));
  });
  it('is used by buildItems', () => {
    const items = buildItems([makeBlock(1, 0, 'Cells make ATP.')], undefined, { pronunciations: list });
    expect(items[0].speak).toBe('Cells make A T P.');
    expect(items[0].text).toBe('Cells make ATP.');
  });
});

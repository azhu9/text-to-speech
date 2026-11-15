import type { SpokenText } from './skip';

export interface Pronunciation {
  id: string;
  /** word or phrase as written */
  from: string;
  /** how to say it, spelled the way it sounds */
  to: string;
  /** match capitals exactly (e.g. "US" but not "us") */
  caseSensitive?: boolean;
}

const KEY = 'read-aloud:pronunciations';

export function loadPronunciations(): Pronunciation[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((p) => p && typeof p.from === 'string' && typeof p.to === 'string') : [];
  } catch {
    return [];
  }
}

export function savePronunciations(list: Pronunciation[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace words in the spoken text, keeping the map back to the original
 * text so word highlighting still lands on the right word.
 */
export function applyPronunciations(input: SpokenText, list: Pronunciation[]): SpokenText {
  const usable = list.filter((p) => p.from.trim() && p.to.trim());
  if (!usable.length) return input;
  usable.sort((a, b) => b.from.trim().length - a.from.trim().length);
  const lookup = new Map<string, string>();
  for (const p of usable) {
    const k = p.caseSensitive ? `=${p.from.trim()}` : `~${p.from.trim().toLowerCase()}`;
    if (!lookup.has(k)) lookup.set(k, p.to.trim());
  }
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${usable.map((p) => escape(p.from.trim())).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const { speak, map } = input;
  let out = '';
  const outMap: number[] = [];
  let last = 0;
  for (const m of speak.matchAll(re)) {
    const word = m[0];
    const to = lookup.get(`=${word}`) ?? lookup.get(`~${word.toLowerCase()}`);
    if (to === undefined) continue; // case-sensitive entry didn't match this casing
    const i = m.index!;
    out += speak.slice(last, i);
    outMap.push(...map.slice(last, i));
    // Spread the replacement over the original word's span.
    const a = map[i];
    const z = map[i + word.length - 1] + 1;
    for (let k = 0; k < to.length; k++) outMap.push(a + Math.floor((k * (z - a)) / to.length));
    out += to;
    last = i + word.length;
  }
  if (last === 0) return input;
  out += speak.slice(last);
  outMap.push(...map.slice(last));
  return { speak: out, map: outMap };
}

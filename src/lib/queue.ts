import { useSyncExternalStore } from 'react';

/** Documents to play next, in order (stored in this browser). */
const KEY = 'read-aloud:queue';
const listeners = new Set<() => void>();

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

let cache = read();

function write(ids: string[]) {
  cache = [...new Set(ids)];
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export const queue = {
  get: () => cache,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  add: (id: string) => write([...cache, id]),
  remove: (id: string) => write(cache.filter((x) => x !== id)),
  move(id: string, delta: number) {
    const i = cache.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= cache.length) return;
    const next = [...cache];
    [next[i], next[j]] = [next[j], next[i]];
    write(next);
  },
  clear: () => write([]),
  /** Take the next document to play after `currentId` (removing it from the queue). */
  takeNext(currentId: string): string | undefined {
    const rest = cache.filter((x) => x !== currentId);
    const next = rest[0];
    write(rest.slice(1));
    return next;
  },
};

export function useQueue(): string[] {
  return useSyncExternalStore(queue.subscribe, queue.get);
}

import { useMemo, useState, type ReactNode } from 'react';
import { newId } from '../lib/db';
import type { Pronunciation } from '../lib/pronounce';
import type { Block } from '../lib/types';

export type SideTab = 'contents' | 'search' | 'notes' | 'pronounce';

const TABS: { id: SideTab; label: string }[] = [
  { id: 'contents', label: 'Contents' },
  { id: 'search', label: 'Search' },
  { id: 'notes', label: 'Notes' },
  { id: 'pronounce', label: 'Pronounce' },
];

export function SidePanel({ tab, onTab, onClose, children }: { tab: SideTab; onTab: (t: SideTab) => void; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="flex h-full w-full flex-col border-l border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-center border-b border-stone-200 px-2 dark:border-stone-800" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`shrink-0 px-2 py-3 text-sm ${tab === t.id ? 'border-b-2 border-sky-600 font-medium text-sky-700 dark:text-sky-400' : 'text-stone-500 hover:text-stone-900 dark:hover:text-stone-100'}`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button className="ml-auto shrink-0 px-2 text-stone-500 hover:text-stone-900 dark:hover:text-stone-100" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </aside>
  );
}

export function ContentsTab({
  blocks,
  skipped,
  isPdf,
  currentBlockId,
  onGo,
}: {
  blocks: Block[];
  skipped: Set<string>;
  isPdf: boolean;
  currentBlockId?: string;
  onGo: (blockId: string) => void;
}) {
  const headings = useMemo(() => blocks.filter((b) => b.heading && !skipped.has(b.id)), [blocks, skipped]);
  const pages = useMemo(() => {
    if (!isPdf) return [];
    const firsts = new Map<number, Block>();
    for (const b of blocks) if (!skipped.has(b.id) && !firsts.has(b.page)) firsts.set(b.page, b);
    return [...firsts.values()];
  }, [blocks, skipped, isPdf]);
  // The section being read: last heading at or before the current paragraph.
  const order = useMemo(() => new Map(blocks.map((b, i) => [b.id, i])), [blocks]);
  const cur = currentBlockId ? (order.get(currentBlockId) ?? -1) : -1;
  const active = headings.filter((h) => (order.get(h.id) ?? 0) <= cur).pop()?.id;
  const [showPages, setShowPages] = useState(false);

  const list = headings.length && !showPages ? headings : pages;
  return (
    <div className="flex h-full flex-col">
      {isPdf && headings.length > 0 && (
        <div className="flex gap-2 px-4 pt-3 text-xs">
          <button className={!showPages ? 'font-semibold text-sky-700 dark:text-sky-400' : 'text-stone-500'} onClick={() => setShowPages(false)}>
            Headings
          </button>
          <span className="text-stone-300">|</span>
          <button className={showPages ? 'font-semibold text-sky-700 dark:text-sky-400' : 'text-stone-500'} onClick={() => setShowPages(true)}>
            Pages
          </button>
        </div>
      )}
      <nav className="flex-1 overflow-y-auto p-2 text-sm">
        {!list.length && <p className="px-2 py-6 text-center text-stone-500 dark:text-stone-400">No headings found in this document.</p>}
        {list.map((b) => {
          const isActive = list === headings ? b.id === active : b.page === (currentBlockId ? Number(currentBlockId.split('-')[0]) : 0);
          return (
            <button
              key={b.id}
              className={`block w-full truncate rounded px-2 py-1.5 text-left ${isActive ? 'bg-sky-50 font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300' : 'hover:bg-stone-100 dark:hover:bg-stone-800'}`}
              onClick={() => onGo(b.id)}
              title={b.text}
            >
              {list === headings ? (
                <>
                  {isPdf && <span className="mr-2 text-xs text-stone-400 tabular-nums">p.{b.page}</span>}
                  {b.text}
                </>
              ) : (
                <>
                  <span className="mr-2 text-xs text-stone-400 tabular-nums">p.{b.page}</span>
                  <span className="text-stone-600 dark:text-stone-300">{b.text.slice(0, 80)}</span>
                </>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export interface SearchHit {
  blockId: string;
  start: number;
  end: number;
}

const MAX_HITS = 300;

export function findInBlocks(blocks: Block[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const b of blocks) {
    const t = b.text.toLowerCase();
    for (let i = t.indexOf(q); i >= 0 && hits.length < MAX_HITS; i = t.indexOf(q, i + q.length)) hits.push({ blockId: b.id, start: i, end: i + q.length });
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

export function SearchTab({
  blocks,
  isPdf,
  query,
  onQuery,
  onGo,
}: {
  blocks: Block[];
  isPdf: boolean;
  query: string;
  onQuery: (q: string) => void;
  onGo: (hit: SearchHit) => void;
}) {
  const hits = useMemo(() => findInBlocks(blocks, query), [blocks, query]);
  const byId = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);
  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <input
          autoFocus
          type="search"
          placeholder="Search this document…"
          className="w-full rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm dark:border-stone-700"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        {query.trim().length >= 2 && (
          <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
            {hits.length >= MAX_HITS ? `${MAX_HITS}+ results` : `${hits.length} result${hits.length === 1 ? '' : 's'}`}
          </p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3 text-sm">
        {hits.map((h, i) => {
          const b = byId.get(h.blockId)!;
          const from = Math.max(0, h.start - 50);
          const to = Math.min(b.text.length, h.end + 70);
          return (
            <button key={i} className="mb-1 block w-full rounded px-2 py-2 text-left hover:bg-stone-100 dark:hover:bg-stone-800" onClick={() => onGo(h)}>
              {isPdf && <span className="mr-1 text-xs text-stone-400">p.{b.page}</span>}
              <span className="font-serif text-stone-700 dark:text-stone-300">
                {from > 0 && '…'}
                {b.text.slice(from, h.start)}
                <mark className="rounded bg-yellow-200 px-0.5 text-stone-900 dark:bg-yellow-600/60 dark:text-stone-50">{b.text.slice(h.start, h.end)}</mark>
                {b.text.slice(h.end, to)}
                {to < b.text.length && '…'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PronounceTab({
  list,
  onChange,
  draft,
  onTry,
}: {
  list: Pronunciation[];
  onChange: (l: Pronunciation[]) => void;
  /** prefilled "from" when opened from a text selection */
  draft: string;
  onTry: (text: string) => void;
}) {
  const [from, setFrom] = useState(draft);
  const [to, setTo] = useState('');
  const [exact, setExact] = useState(false);
  const [lastDraft, setLastDraft] = useState(draft);
  if (draft !== lastDraft) {
    setLastDraft(draft);
    setFrom(draft);
    setTo('');
  }
  const add = () => {
    if (!from.trim() || !to.trim()) return;
    const rest = list.filter((p) => p.from.trim().toLowerCase() !== from.trim().toLowerCase());
    onChange([...rest, { id: newId(), from: from.trim(), to: to.trim(), caseSensitive: exact || undefined }]);
    setFrom('');
    setTo('');
    setExact(false);
  };
  return (
    <div className="flex h-full flex-col text-sm">
      <form
        className="space-y-2 border-b border-stone-200 p-3 dark:border-stone-800"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <p className="text-xs text-stone-500 dark:text-stone-400">Teach the voice how to say a word. Spell it the way it sounds. Applies to all documents.</p>
        <div className="flex gap-2">
          <input aria-label="Word" placeholder="Word, e.g. ATP" className="min-w-0 flex-1 rounded border border-stone-300 bg-transparent px-2 py-1.5 dark:border-stone-700" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input aria-label="Say it as" placeholder="Say as, e.g. A T P" className="min-w-0 flex-1 rounded border border-stone-300 bg-transparent px-2 py-1.5 dark:border-stone-700" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" className="accent-sky-600" checked={exact} onChange={(e) => setExact(e.target.checked)} />
            Match capitals exactly
          </label>
          <button type="button" className="ml-auto text-xs text-sky-700 hover:underline disabled:opacity-40 dark:text-sky-400" disabled={!to.trim()} onClick={() => onTry(to)}>
            ▶ Try it
          </button>
          <button type="submit" className="rounded bg-sky-600 px-3 py-1 font-medium text-white hover:bg-sky-700 disabled:opacity-40" disabled={!from.trim() || !to.trim()}>
            Add
          </button>
        </div>
      </form>
      <ul className="flex-1 overflow-y-auto p-2">
        {!list.length && <li className="px-2 py-6 text-center text-stone-500 dark:text-stone-400">No custom pronunciations yet. Tip: select a word in the text and choose "Pronounce".</li>}
        {list.map((p) => (
          <li key={p.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-800/50">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{p.from}</span>
              <span className="mx-1.5 text-stone-400">→</span>
              <span>{p.to}</span>
              {p.caseSensitive && <span className="ml-1.5 text-xs text-stone-400">(exact case)</span>}
            </span>
            <button className="text-xs text-sky-700 hover:underline dark:text-sky-400" onClick={() => onTry(p.to)} aria-label={`Try ${p.from}`}>
              ▶
            </button>
            <button className="text-xs text-stone-500 hover:text-red-600" onClick={() => onChange(list.filter((x) => x.id !== p.id))} aria-label={`Remove ${p.from}`}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

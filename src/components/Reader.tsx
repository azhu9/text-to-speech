import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { db, newId } from '../lib/db';
import { openLibrary } from '../lib/nav';
import { ocr } from '../lib/ocr';
import { buildItems, SpeechPlayer } from '../lib/player';
import { blockOrder } from '../lib/segment';
import { inlineSkips, loadSkipOptions, saveSkipOptions, SKIP_LABELS, skippedBlocks, type Range, type SkipOptions } from '../lib/skip';
import { readSelection, type TextSelection } from '../lib/selection';
import type { Annotation, Block, HighlightColor } from '../lib/types';
import { BlockView } from './BlockView';
import { COLORS, NotesPanel } from './NotesPanel';
import { PlayerBar } from './PlayerBar';

const EMPTY: Annotation[] = [];
const NO_RANGES: Range[] = [];
const FONT_KEY = 'read-aloud:font-size';

function annotationSortKey(a: Annotation): [number, number, number] {
  const r = a.ranges[0];
  const [p, b] = blockOrder(r.blockId);
  return [p, b, r.start];
}

function compareAnnotations(x: Annotation, y: Annotation) {
  const a = annotationSortKey(x);
  const b = annotationSortKey(y);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function loadFontSize() {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    return n >= 14 && n <= 32 ? n : 20;
  } catch {
    return 20;
  }
}

export function Reader({ docId }: { docId: string }) {
  const doc = useLiveQuery(() => db.docs.get(docId), [docId], null);
  const pages = useLiveQuery(() => db.pages.where('docId').equals(docId).sortBy('page'), [docId]);
  const annotationsRaw = useLiveQuery(() => db.annotations.where('docId').equals(docId).toArray(), [docId]);

  const [player] = useState(() => new SpeechPlayer());
  const state = useSyncExternalStore(player.subscribe, player.getState);
  const [showNotes, setShowNotes] = useState(true);
  const [selectedAnn, setSelectedAnn] = useState<{ id: string; focusNote: boolean } | null>(null);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [fontSize, setFontSize] = useState(loadFontSize);
  const [skip, setSkip] = useState<SkipOptions>(loadSkipOptions);
  const [showSkip, setShowSkip] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledAt = useRef(0);
  const initialized = useRef(false);

  const blocks = useMemo<Block[]>(() => (pages ?? []).flatMap((p) => p.blocks), [pages]);
  const items = useMemo(() => buildItems(blocks, skip), [blocks, skip]);
  const skippedIds = useMemo(() => skippedBlocks(blocks, skip), [blocks, skip]);
  const skipRanges = useMemo(() => {
    const m = new Map<string, Range[]>();
    for (const b of blocks) {
      const r = inlineSkips(b.text, skip);
      if (r.length) m.set(b.id, r);
    }
    return m;
  }, [blocks, skip]);
  // wordsAfter[i] = words from sentence i to the end
  const wordsAfter = useMemo(() => {
    const out = new Array<number>(items.length + 1).fill(0);
    for (let i = items.length - 1; i >= 0; i--) out[i] = out[i + 1] + items[i].words;
    return out;
  }, [items]);

  useEffect(() => saveSkipOptions(skip), [skip]);
  const annotations = useMemo(() => [...(annotationsRaw ?? [])].sort(compareAnnotations), [annotationsRaw]);
  const annsByBlock = useMemo(() => {
    const m = new Map<string, Annotation[]>();
    for (const a of annotations)
      for (const r of a.ranges) {
        const list = m.get(r.blockId) ?? [];
        if (!list.includes(a)) list.push(a);
        m.set(r.blockId, list);
      }
    return m;
  }, [annotations]);

  // Load sentences into the player; restore the saved position the first time.
  useEffect(() => {
    if (!doc || !pages) return;
    if (!initialized.current) {
      initialized.current = true;
      player.setItems(items, doc.position);
      void db.docs.update(docId, { openedAt: Date.now() });
    } else {
      player.setItems(items);
    }
  }, [items, doc, pages, player, docId]);

  useEffect(() => () => player.destroy(), [player]);

  const current = items[state.index];
  const currentPage = current ? blockOrder(current.blockId)[0] : 1;

  // Save reading position (throttled).
  useEffect(() => {
    if (!initialized.current || !current) return;
    const t = setTimeout(() => {
      void db.docs.update(docId, {
        position: { blockId: current.blockId, sentence: current.sentence },
        progress: items.length > 1 ? state.index / (items.length - 1) : 0,
      });
    }, 600);
    return () => clearTimeout(t);
  }, [current, docId, items.length, state.index]);

  // Point OCR at the area being read.
  useEffect(() => {
    if (doc?.ocrPending) ocr.setFocus(docId, currentPage);
  }, [doc?.ocrPending, docId, currentPage]);

  // Keep the sentence being read in view, unless the user is scrolling around.
  useEffect(() => {
    if (Date.now() - userScrolledAt.current < 4000) return;
    const el = textRef.current?.querySelector<HTMLElement>('[data-active]');
    if (!el || !scrollRef.current) return;
    const box = el.getBoundingClientRect();
    const view = scrollRef.current.getBoundingClientRect();
    if (box.top < view.top + 60 || box.bottom > view.bottom - 60) el.scrollIntoView({ block: 'center', behavior: state.playing ? 'smooth' : 'auto' });
  }, [state.index, state.playing, blocks]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ') player.toggle();
      else if (e.key === 'ArrowRight') player.next();
      else if (e.key === 'ArrowLeft') player.prev();
      else if (e.key === '+' || e.key === '=') player.setRate(state.rate + 0.1);
      else if (e.key === '-') player.setRate(state.rate - 0.1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player, state.rate]);

  useEffect(() => {
    try {
      localStorage.setItem(FONT_KEY, String(fontSize));
    } catch {
      /* ignore */
    }
  }, [fontSize]);

  const updateSelection = useCallback(() => {
    // Let the browser finish updating the selection first.
    requestAnimationFrame(() => setSelection(textRef.current ? readSelection(textRef.current) : null));
  }, []);

  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setSelection(null);
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  const onTextClick = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const target = e.target as HTMLElement;
    const annId = target.closest<HTMLElement>('[data-ann]')?.dataset.ann;
    if (annId) {
      setSelectedAnn({ id: annId, focusNote: false });
      setShowNotes(true);
    }
    const s = target.closest<HTMLElement>('[data-s]')?.dataset.s;
    const blockId = target.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
    if (s != null && blockId) {
      userScrolledAt.current = 0;
      player.seekTo({ blockId, sentence: Number(s) });
    }
  };

  async function addAnnotation(color: HighlightColor, withNote: boolean) {
    if (!selection) return;
    const now = Date.now();
    const a: Annotation = { id: newId(), docId, ranges: selection.ranges, quote: selection.quote, color, note: '', createdAt: now, updatedAt: now };
    await db.annotations.add(a);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    if (withNote) {
      setShowNotes(true);
      setSelectedAnn({ id: a.id, focusNote: true });
    }
  }

  function listenFromSelection() {
    if (!selection) return;
    const r = selection.ranges[0];
    const block = blocks.find((b) => b.id === r.blockId);
    const idx = block?.sentences.findIndex(([, e]) => r.start < e) ?? -1;
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    userScrolledAt.current = 0;
    if (idx >= 0) player.seekTo({ blockId: r.blockId, sentence: idx }, true);
  }

  function goToAnnotation(a: Annotation) {
    setSelectedAnn({ id: a.id, focusNote: false });
    const r = a.ranges[0];
    const el = textRef.current?.querySelector(`[data-block-id="${r.blockId}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    userScrolledAt.current = Date.now();
    const block = blocks.find((b) => b.id === r.blockId);
    const idx = block?.sentences.findIndex(([, e]) => r.start < e) ?? -1;
    if (idx >= 0) player.seekTo({ blockId: r.blockId, sentence: idx });
  }

  function exportNotes() {
    if (!doc) return;
    const lines = [`# ${doc.title}`, '', `Highlights and notes, exported ${new Date().toLocaleDateString()}`, ''];
    for (const a of annotations) {
      const page = blockOrder(a.ranges[0].blockId)[0];
      lines.push(...a.quote.split('\n').map((l) => `> ${l}`));
      if (doc.kind === 'pdf') lines.push(`>`, `> — page ${page}`);
      lines.push('');
      if (a.note.trim()) lines.push(a.note.trim(), '');
      lines.push('---', '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${doc.title.replace(/[\\/:*?"<>|]+/g, '_')} - notes.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (doc === undefined) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="mb-4">This document isn't in your library.</p>
          <button className="text-sky-700 underline dark:text-sky-400" onClick={openLibrary}>
            Back to library
          </button>
        </div>
      </div>
    );
  }

  const failedPages = pages?.filter((p) => p.status === 'ocr-failed').length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-2 dark:border-stone-800 dark:bg-stone-900">
        <button className="rounded px-2 py-1 text-sm hover:bg-stone-100 dark:hover:bg-stone-800" onClick={openLibrary}>
          ← Library
        </button>
        <h1 className="min-w-0 flex-1 truncate font-medium">{doc?.title}</h1>
        {doc?.kind === 'pdf' && (
          <span className="hidden text-sm text-stone-500 sm:inline dark:text-stone-400">
            Page {currentPage} of {doc.pageCount}
          </span>
        )}
        {!!doc?.ocrPending && <span className="text-sm text-amber-700 dark:text-amber-400">Scanning text: {doc.ocrPending} pages left</span>}
        {failedPages > 0 && <span className="text-sm text-red-600">{failedPages} page(s) couldn't be read</span>}
        <div className="relative">
          <button
            className={`rounded px-2 py-1 text-sm ${showSkip ? 'bg-stone-200 dark:bg-stone-800' : 'hover:bg-stone-100 dark:hover:bg-stone-800'}`}
            onClick={() => setShowSkip((v) => !v)}
            aria-expanded={showSkip}
          >
            Skip
          </button>
          {showSkip && (
            <div className="absolute right-0 z-30 mt-2 w-72 rounded-lg border border-stone-200 bg-white p-3 text-sm shadow-lg dark:border-stone-700 dark:bg-stone-900">
              <p className="mb-2 font-medium">Don't read aloud</p>
              {(Object.keys(SKIP_LABELS) as (keyof SkipOptions)[]).map((k) => (
                <label key={k} className="flex cursor-pointer items-start gap-2 py-1">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-sky-600"
                    checked={skip[k]}
                    onChange={(e) => setSkip((o) => ({ ...o, [k]: e.target.checked }))}
                  />
                  <span>{SKIP_LABELS[k]}</span>
                </label>
              ))}
              <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">Skipped text stays visible in grey.</p>
            </div>
          )}
        </div>
        <div className="flex items-center rounded border border-stone-200 dark:border-stone-700">
          <button className="px-2 py-1 text-sm" onClick={() => setFontSize((f) => Math.max(14, f - 2))} aria-label="Smaller text">
            A−
          </button>
          <button className="px-2 py-1 text-base" onClick={() => setFontSize((f) => Math.min(32, f + 2))} aria-label="Larger text">
            A+
          </button>
        </div>
        <button
          className={`rounded px-2 py-1 text-sm ${showNotes ? 'bg-stone-200 dark:bg-stone-800' : 'hover:bg-stone-100 dark:hover:bg-stone-800'}`}
          onClick={() => setShowNotes((s) => !s)}
        >
          Notes{annotations.length ? ` (${annotations.length})` : ''}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="min-w-0 flex-1 overflow-y-auto"
          onWheel={() => (userScrolledAt.current = Date.now())}
          onTouchMove={() => (userScrolledAt.current = Date.now())}
        >
          <div
            ref={textRef}
            className="mx-auto max-w-3xl px-6 py-10 font-serif leading-relaxed"
            style={{ fontSize }}
            onMouseUp={updateSelection}
            onKeyUp={updateSelection}
            onClick={onTextClick}
          >
            {!pages ? (
              <p className="text-stone-500">Loading…</p>
            ) : !items.length && !doc?.ocrPending ? (
              <p className="text-stone-500">No readable text was found in this document.</p>
            ) : (
              pages.map((p) => (
                <section key={p.page} data-page={p.page}>
                  {doc?.kind === 'pdf' && (
                    <div className="mt-6 mb-4 flex items-center gap-3 font-sans text-xs uppercase tracking-wider text-stone-400 select-none">
                      <span>Page {p.page}</span>
                      <span className="h-px flex-1 bg-stone-200 dark:bg-stone-800" />
                    </div>
                  )}
                  {p.status === 'ocr-pending' && (
                    <p className="mb-5 rounded-lg bg-amber-50 px-4 py-3 font-sans text-sm text-amber-900 select-none dark:bg-amber-950 dark:text-amber-100">
                      This page is a scanned image. Converting it to text…
                    </p>
                  )}
                  {p.status === 'ocr-failed' && (
                    <p className="mb-5 rounded-lg bg-red-50 px-4 py-3 font-sans text-sm text-red-900 select-none dark:bg-red-950 dark:text-red-100">
                      Couldn't read the text on this page.{' '}
                      <button className="underline" onClick={() => void ocr.retry(docId, p.page)}>
                        Try again
                      </button>
                    </p>
                  )}
                  {p.blocks.map((b) => {
                    const active = current?.blockId === b.id;
                    return (
                      <BlockView
                        key={b.id}
                        block={b}
                        activeSentence={active ? current.sentence : -1}
                        word={active ? state.word : null}
                        annotations={annsByBlock.get(b.id) ?? EMPTY}
                        skipped={skippedIds.has(b.id)}
                        skips={skipRanges.get(b.id) ?? NO_RANGES}
                      />
                    );
                  })}
                </section>
              ))
            )}
          </div>
        </div>

        {showNotes && (
          <div className="hidden w-80 shrink-0 lg:block">
            <NotesPanel
              annotations={annotations}
              selectedId={selectedAnn?.id ?? null}
              focusNote={!!selectedAnn?.focusNote}
              showPages={doc?.kind === 'pdf'}
              onSelect={goToAnnotation}
              onExport={exportNotes}
              onClose={() => setShowNotes(false)}
            />
          </div>
        )}
      </div>

      <PlayerBar player={player} state={state} wordsLeft={wordsAfter[state.index] ?? 0} />

      {selection && (
        <div
          className="fixed z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg bg-stone-900 px-2 py-1.5 text-sm text-white shadow-lg dark:bg-stone-100 dark:text-stone-900"
          style={{
            left: Math.min(window.innerWidth - 150, Math.max(150, selection.rect.left + selection.rect.width / 2)),
            top: Math.max(8, selection.rect.top - 48),
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {COLORS.map((c) => (
            <button key={c} className={`hl-${c} h-6 w-6 rounded-full border border-white/40`} onClick={() => void addAnnotation(c, false)} aria-label={`Highlight ${c}`} title={`Highlight (${c})`} />
          ))}
          <span className="mx-1 h-5 w-px bg-white/30 dark:bg-stone-900/30" />
          <button className="rounded px-2 py-0.5 hover:bg-white/10" onClick={() => void addAnnotation('yellow', true)}>
            Note
          </button>
          <button className="rounded px-2 py-0.5 hover:bg-white/10" onClick={listenFromSelection}>
            ▶ Listen from here
          </button>
        </div>
      )}
    </div>
  );
}

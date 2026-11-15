import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { db, newId } from '../lib/db';
import { updateBlockText } from '../lib/importer';
import { loadPronunciations, savePronunciations, type Pronunciation } from '../lib/pronounce';
import { SETTINGS_EVENT } from '../lib/settingsSync';
import { openDoc, openLibrary } from '../lib/nav';
import { queue, useQueue } from '../lib/queue';
import { ocr } from '../lib/ocr';
import { buildItems, SpeechPlayer } from '../lib/player';
import { blockOrder } from '../lib/segment';
import {
  applyUserRules,
  inlineSkips,
  loadGlobalPatterns,
  loadSkipOptions,
  saveGlobalPatterns,
  saveSkipOptions,
  SKIP_LABELS,
  skippedBlocks,
  type Range,
  type SkipOptions,
} from '../lib/skip';
import { readSelection, type TextSelection } from '../lib/selection';
import type { Annotation, Block, DocRules, HighlightColor } from '../lib/types';
import { BlockEditor, BlockMenu, type BlockMenuAction } from './BlockMenu';
import { BlockView } from './BlockView';
import { COLORS, NotesPanel } from './NotesPanel';
import { ContentsTab, findInBlocks, PronounceTab, SearchTab, SidePanel, type SearchHit, type SideTab } from './SidePanel';
import { PlayerBar } from './PlayerBar';

const EMPTY: Annotation[] = [];
const NO_RANGES: Range[] = [];
const FONT_KEY = 'read-aloud:font-size';
const PANEL_KEY = 'read-aloud:panel';
const PANEL_TABS: SideTab[] = ['contents', 'search', 'notes', 'pronounce'];
function loadPanel(): SideTab | null {
  try {
    const v = localStorage.getItem(PANEL_KEY);
    if (v === 'closed') return null;
    return PANEL_TABS.includes(v as SideTab) ? (v as SideTab) : 'contents';
  } catch {
    return 'contents';
  }
}
const short = (t: string, n = 60) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

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

export function Reader({ docId, autoplay = false }: { docId: string; autoplay?: boolean }) {
  const doc = useLiveQuery(() => db.docs.get(docId), [docId], null);
  const pages = useLiveQuery(() => db.pages.where('docId').equals(docId).sortBy('page'), [docId]);
  const annotationsRaw = useLiveQuery(() => db.annotations.where('docId').equals(docId).toArray(), [docId]);

  const [player] = useState(() => new SpeechPlayer());
  const state = useSyncExternalStore(player.subscribe, player.getState);
  const [panel, setPanel] = useState<SideTab | null>(loadPanel);
  const [globalPatterns, setGlobalPatterns] = useState<string[]>(loadGlobalPatterns);
  const [pronunciations, setPronunciations] = useState<Pronunciation[]>(loadPronunciations);
  const [pronounceDraft, setPronounceDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; blockId: string } | null>(null);
  const [hover, setHover] = useState<{ blockId: string; top: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
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
  const autoSkipped = useMemo(() => skippedBlocks(blocks, skip), [blocks, skip]);
  // doc changes on every position save; only recompute when the rules change.
  const rulesKey = JSON.stringify(doc?.rules ?? {});
  const rules = useMemo<DocRules>(() => JSON.parse(rulesKey), [rulesKey]);
  const skippedIds = useMemo(() => applyUserRules(blocks, autoSkipped, rules, globalPatterns), [blocks, autoSkipped, rules, globalPatterns]);
  const items = useMemo(() => buildItems(blocks, skip, { skipped: skippedIds, pronunciations }), [blocks, skip, skippedIds, pronunciations]);
  const skipRanges = useMemo(() => {
    const m = new Map<string, Range[]>();
    for (const b of blocks) {
      const r = inlineSkips(b.text, skip);
      if (r.length) m.set(b.id, r);
    }
    return m;
  }, [blocks, skip]);
  // Search matches, highlighted in the text while the Search tab is open.
  const marksByBlock = useMemo(() => {
    const m = new Map<string, Range[]>();
    if (panel !== 'search') return m;
    for (const h of findInBlocks(blocks, searchQuery)) {
      const list = m.get(h.blockId) ?? [];
      list.push([h.start, h.end]);
      m.set(h.blockId, list);
    }
    return m;
  }, [blocks, searchQuery, panel]);
  // wordsAfter[i] = words from sentence i to the end
  const wordsAfter = useMemo(() => {
    const out = new Array<number>(items.length + 1).fill(0);
    for (let i = items.length - 1; i >= 0; i--) out[i] = out[i + 1] + items[i].words;
    return out;
  }, [items]);

  useEffect(() => saveSkipOptions(skip), [skip]);
  // Settings changed on another device and just synced down.
  useEffect(() => {
    const onRemote = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.local) return;
      if (d?.key === 'read-aloud:skip') setSkip(loadSkipOptions());
      if (d?.key === 'read-aloud:skip-patterns') setGlobalPatterns(loadGlobalPatterns());
      if (d?.key === 'read-aloud:pronunciations') setPronunciations(loadPronunciations());
    };
    window.addEventListener(SETTINGS_EVENT, onRemote);
    return () => window.removeEventListener(SETTINGS_EVENT, onRemote);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_KEY, panel ?? 'closed');
    } catch {
      /* ignore */
    }
  }, [panel]);
  useEffect(() => saveGlobalPatterns(globalPatterns), [globalPatterns]);
  useEffect(() => savePronunciations(pronunciations), [pronunciations]);
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
      // Finished documents start over.
      player.setItems(items, doc.progress >= 0.999 ? undefined : doc.position);
      void db.docs.update(docId, { openedAt: Date.now() });
      queue.remove(docId);
      if (autoplay) {
        // Clear "?play=1" so a reload doesn't auto-start.
        history.replaceState(null, '', `#/doc/${encodeURIComponent(docId)}`);
        setTimeout(() => player.play(), 300);
      }
    } else {
      player.setItems(items);
    }
  }, [items, doc, pages, player, docId]);

  useEffect(() => () => player.destroy(), [player]);

  // Listening queue: when this document ends, continue with the next one.
  const queued = useQueue();
  const upNextId = queued.find((id) => id !== docId);
  const upNext = useLiveQuery(() => (upNextId ? db.docs.get(upNextId) : undefined), [upNextId]);
  const playNext = useCallback(() => {
    const next = queue.takeNext(docId);
    if (next) openDoc(next, { autoplay: true });
  }, [docId]);
  useEffect(() => {
    if (state.ended && upNextId) {
      const t = setTimeout(playNext, 1200);
      return () => clearTimeout(t);
    }
  }, [state.ended, upNextId, playNext]);

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
      setPanel('notes');
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
      setPanel('notes');
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

  /** Scroll to a paragraph and move the reading position there. */
  function goToBlock(blockId: string, char = 0, play = false) {
    const el = textRef.current?.querySelector(`[data-block-id="${blockId}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    userScrolledAt.current = Date.now();
    const block = blocks.find((b) => b.id === blockId);
    const idx = block?.sentences.findIndex(([, e]) => char < e) ?? -1;
    player.seekTo({ blockId, sentence: Math.max(0, idx) }, play);
  }

  function goToHit(h: SearchHit) {
    goToBlock(h.blockId, h.start);
  }

  function updateRules(fn: (r: DocRules) => DocRules) {
    const next = fn(rules);
    const clean: DocRules = {};
    if (next.skip?.length) clean.skip = [...new Set(next.skip)];
    if (next.read?.length) clean.read = [...new Set(next.read)];
    if (next.patterns?.length) clean.patterns = [...new Set(next.patterns)];
    void db.docs.update(docId, { rules: clean });
  }

  function blockActions(blockId: string): BlockMenuAction[] {
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return [];
    const skipped = skippedIds.has(blockId);
    const userSkipped = !!rules.skip?.includes(blockId);
    const actions: BlockMenuAction[] = [];
    if (!skipped) actions.push({ label: '▶ Read from here', onClick: () => goToBlock(blockId, 0, true) });
    if (skipped)
      actions.push({
        label: 'Read this paragraph',
        hint: userSkipped ? 'Undo "skip"' : 'It was skipped automatically',
        onClick: () => updateRules((r) => ({ ...r, skip: r.skip?.filter((id) => id !== blockId), read: userSkipped ? r.read : [...(r.read ?? []), blockId] })),
      });
    else
      actions.push(
        {
          label: "Don't read this paragraph",
          onClick: () => updateRules((r) => ({ ...r, skip: [...(r.skip ?? []), blockId], read: r.read?.filter((id) => id !== blockId) })),
        },
        {
          label: "Don't read anything like this",
          hint: 'Skips similar paragraphs in this document (e.g. a repeated footer)',
          onClick: () => updateRules((r) => ({ ...r, patterns: [...(r.patterns ?? []), block.text], read: r.read?.filter((id) => id !== blockId) })),
        },
        {
          label: "Don't read anything like this, in any document",
          hint: 'For notices that show up in many files',
          onClick: () => setGlobalPatterns((g) => [...g, block.text]),
        },
      );
    actions.push({ label: 'Edit text…', hint: 'Fix a misread word or sentence', onClick: () => setEditing(blockId) });
    return actions;
  }

  function onTextMouseMove(e: React.MouseEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-block-id]');
    if (!el || !textRef.current) return;
    const id = el.dataset.blockId!;
    if (hover?.blockId !== id) setHover({ blockId: id, top: el.offsetTop });
  }

  function onTextContextMenu(e: React.MouseEvent) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // keep the browser menu for copying a selection
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
    if (!id) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, blockId: id });
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
              <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
                Skipped text stays visible in grey. Right-click any paragraph (or use its ⋯ button) to skip it or similar ones.
              </p>
              {(rules.skip?.length || rules.read?.length || rules.patterns?.length || globalPatterns.length) ? (
                <div className="mt-3 border-t border-stone-200 pt-2 text-xs dark:border-stone-700">
                  <p className="mb-1 font-medium">Your choices</p>
                  {!!rules.skip?.length && (
                    <RuleRow text={`${rules.skip.length} paragraph${rules.skip.length === 1 ? '' : 's'} skipped in this document`} onRemove={() => updateRules((r) => ({ ...r, skip: [] }))} />
                  )}
                  {!!rules.read?.length && (
                    <RuleRow text={`${rules.read.length} paragraph${rules.read.length === 1 ? '' : 's'} always read here`} onRemove={() => updateRules((r) => ({ ...r, read: [] }))} />
                  )}
                  {rules.patterns?.map((t) => (
                    <RuleRow key={t} text={`Like “${short(t, 40)}” (this document)`} onRemove={() => updateRules((r) => ({ ...r, patterns: r.patterns?.filter((x) => x !== t) }))} />
                  ))}
                  {globalPatterns.map((t) => (
                    <RuleRow key={t} text={`Like “${short(t, 40)}” (all documents)`} onRemove={() => setGlobalPatterns((g) => g.filter((x) => x !== t))} />
                  ))}
                </div>
              ) : null}
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
          className={`rounded px-2 py-1 text-sm ${panel ? 'bg-stone-200 dark:bg-stone-800' : 'hover:bg-stone-100 dark:hover:bg-stone-800'}`}
          onClick={() => setPanel((p) => (p ? null : 'contents'))}
          title="Contents, search, notes and pronunciations"
        >
          Panel{annotations.length ? ` · ${annotations.length} notes` : ''}
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
            className="relative mx-auto max-w-3xl px-8 py-10 font-serif leading-relaxed"
            style={{ fontSize }}
            onMouseUp={updateSelection}
            onKeyUp={updateSelection}
            onClick={onTextClick}
            onMouseMove={onTextMouseMove}
            onMouseLeave={() => setHover(null)}
            onContextMenu={onTextContextMenu}
          >
            {hover && !editing && (
              <button
                className="absolute left-0 z-10 grid h-7 w-7 place-items-center rounded font-sans text-base leading-none text-stone-400 hover:bg-stone-200 hover:text-stone-800 dark:hover:bg-stone-800 dark:hover:text-stone-100"
                style={{ top: hover.top }}
                aria-label="Paragraph options"
                title="Paragraph options (or right-click)"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({ x: r.left, y: r.bottom + 4, blockId: hover.blockId });
                }}
              >
                ⋯
              </button>
            )}
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
                    if (editing === b.id)
                      return (
                        <BlockEditor
                          key={b.id}
                          text={b.text}
                          onCancel={() => setEditing(null)}
                          onSave={(t) => {
                            setEditing(null);
                            if (t.trim() && t.trim() !== b.text) void updateBlockText(docId, b.id, t);
                          }}
                        />
                      );
                    return (
                      <BlockView
                        key={b.id}
                        block={b}
                        activeSentence={active ? current.sentence : -1}
                        word={active ? state.word : null}
                        annotations={annsByBlock.get(b.id) ?? EMPTY}
                        skipped={skippedIds.has(b.id)}
                        skips={skipRanges.get(b.id) ?? NO_RANGES}
                        marks={marksByBlock.get(b.id) ?? NO_RANGES}
                      />
                    );
                  })}
                </section>
              ))
            )}
          </div>
        </div>

        {panel && (
          <div className="hidden w-[22rem] shrink-0 lg:block">
            <SidePanel tab={panel} onTab={setPanel} onClose={() => setPanel(null)}>
              {panel === 'contents' && (
                <ContentsTab blocks={blocks} skipped={skippedIds} isPdf={doc?.kind === 'pdf'} currentBlockId={current?.blockId} onGo={(id) => goToBlock(id)} />
              )}
              {panel === 'search' && <SearchTab blocks={blocks} isPdf={doc?.kind === 'pdf'} query={searchQuery} onQuery={setSearchQuery} onGo={goToHit} />}
              {panel === 'notes' && (
                <NotesPanel
                  annotations={annotations}
                  selectedId={selectedAnn?.id ?? null}
                  focusNote={!!selectedAnn?.focusNote}
                  showPages={doc?.kind === 'pdf'}
                  onSelect={goToAnnotation}
                  onExport={exportNotes}
                />
              )}
              {panel === 'pronounce' && (
                <PronounceTab list={pronunciations} onChange={setPronunciations} draft={pronounceDraft} onTry={(t) => player.preview(t)} />
              )}
            </SidePanel>
          </div>
        )}
      </div>

      <PlayerBar
        player={player}
        state={state}
        wordsLeft={wordsAfter[state.index] ?? 0}
        upNext={upNext ? { title: upNext.title, onPlay: playNext } : undefined}
      />

      {menu && <BlockMenu x={menu.x} y={menu.y} actions={blockActions(menu.blockId)} onClose={closeMenu} />}

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
          {selection.quote.length <= 40 && !selection.quote.includes('\n') && (
            <button
              className="rounded px-2 py-0.5 hover:bg-white/10"
              title="Change how this word is said"
              onClick={() => {
                setPronounceDraft(selection.quote.trim());
                setPanel('pronounce');
                window.getSelection()?.removeAllRanges();
                setSelection(null);
              }}
            >
              Pronounce…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RuleRow({ text, onRemove }: { text: string; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      <button className="shrink-0 text-stone-500 hover:text-red-600" onClick={onRemove}>
        Undo
      </button>
    </div>
  );
}

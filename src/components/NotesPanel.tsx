import { useEffect, useRef } from 'react';
import { db } from '../lib/db';
import type { Annotation, HighlightColor } from '../lib/types';

export const COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink'];

interface Props {
  annotations: Annotation[];
  selectedId: string | null;
  focusNote: boolean;
  showPages: boolean;
  onSelect: (a: Annotation) => void;
  onExport: () => void;
  onClose: () => void;
}

export function NotesPanel({ annotations, selectedId, focusNote, showPages, onSelect, onExport, onClose }: Props) {
  return (
    <aside className="flex h-full w-full flex-col border-l border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3 dark:border-stone-800">
        <h2 className="font-semibold">Highlights &amp; notes</h2>
        <div className="flex items-center gap-3 text-sm">
          <button className="text-sky-700 hover:underline disabled:opacity-40 dark:text-sky-400" onClick={onExport} disabled={!annotations.length}>
            Export
          </button>
          <button className="text-stone-500 hover:text-stone-900 dark:hover:text-stone-100" onClick={onClose} aria-label="Close notes">
            ✕
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {!annotations.length && (
          <p className="px-1 py-6 text-center text-sm text-stone-500 dark:text-stone-400">
            Select text in the document to highlight it or add a note.
          </p>
        )}
        {annotations.map((a) => (
          <NoteCard key={a.id} a={a} selected={a.id === selectedId} focusNote={focusNote && a.id === selectedId} showPage={showPages} onSelect={onSelect} />
        ))}
      </div>
    </aside>
  );
}

function NoteCard({ a, selected, focusNote, showPage, onSelect }: { a: Annotation; selected: boolean; focusNote: boolean; showPage: boolean; onSelect: (a: Annotation) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!selected) return;
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (focusNote) area.current?.focus();
  }, [selected, focusNote]);

  const page = a.ranges[0]?.blockId.split('-')[0];
  return (
    <div
      ref={ref}
      className={`mb-3 rounded-lg border p-3 text-sm ${selected ? 'border-sky-500 ring-1 ring-sky-500' : 'border-stone-200 dark:border-stone-700'}`}
    >
      <button className="block w-full text-left" onClick={() => onSelect(a)} title="Go to this passage">
        <span className={`hl-${a.color} line-clamp-4 rounded px-0.5 font-serif`}>{a.quote}</span>
      </button>
      <textarea
        ref={area}
        className="mt-2 w-full resize-y rounded border border-stone-200 bg-transparent px-2 py-1 text-sm dark:border-stone-700"
        rows={a.note ? 3 : 1}
        placeholder="Add a note…"
        value={a.note}
        onChange={(e) => void db.annotations.update(a.id, { note: e.target.value, updatedAt: Date.now() })}
      />
      <div className="mt-2 flex items-center gap-2">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`hl-${c} h-4 w-4 rounded-full ${a.color === c ? 'ring-2 ring-stone-500' : ''}`}
            onClick={() => void db.annotations.update(a.id, { color: c, updatedAt: Date.now() })}
            aria-label={`Colour ${c}`}
          />
        ))}
        {showPage && page && <span className="ml-1 text-xs text-stone-400">p. {page}</span>}
        <button className="ml-auto text-xs text-stone-500 hover:text-red-600" onClick={() => void db.annotations.delete(a.id)}>
          Delete
        </button>
      </div>
    </div>
  );
}

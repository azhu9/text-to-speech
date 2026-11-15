import { useEffect, useRef } from 'react';

export interface BlockMenuAction {
  label: string;
  hint?: string;
  onClick: () => void;
}

/** Small popup menu for one paragraph. */
export function BlockMenu({ x, y, actions, onClose }: { x: number; y: number; actions: BlockMenuAction[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);
  const left = Math.min(x, window.innerWidth - 300);
  const top = Math.min(y, window.innerHeight - 40 * actions.length - 20);
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-40 w-72 overflow-hidden rounded-lg border border-stone-200 bg-white py-1 text-sm shadow-xl dark:border-stone-700 dark:bg-stone-900"
      style={{ left, top }}
    >
      {actions.map((a) => (
        <button
          key={a.label}
          role="menuitem"
          className="block w-full px-3 py-2 text-left hover:bg-stone-100 focus:bg-stone-100 focus:outline-none dark:hover:bg-stone-800 dark:focus:bg-stone-800"
          onClick={() => {
            onClose();
            a.onClick();
          }}
        >
          {a.label}
          {a.hint && <span className="block text-xs text-stone-500 dark:text-stone-400">{a.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/** Inline editor for fixing a paragraph's text. */
export function BlockEditor({ text, onSave, onCancel }: { text: string; onSave: (t: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.style.height = `${el.scrollHeight + 4}px`;
  }, []);
  return (
    <div className="mb-5 font-sans">
      <textarea
        ref={ref}
        defaultValue={text}
        className="w-full rounded-lg border border-sky-400 bg-white p-3 font-serif text-[1em] leading-relaxed outline-none focus:ring-2 focus:ring-sky-400 dark:bg-stone-900"
        onInput={(e) => {
          const el = e.currentTarget;
          el.style.height = 'auto';
          el.style.height = `${el.scrollHeight + 4}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave(e.currentTarget.value);
        }}
      />
      <div className="mt-2 flex items-center gap-2 text-sm">
        <button className="rounded bg-sky-600 px-3 py-1 font-medium text-white hover:bg-sky-700" onClick={() => onSave(ref.current?.value ?? text)}>
          Save
        </button>
        <button className="rounded px-3 py-1 hover:bg-stone-200 dark:hover:bg-stone-800" onClick={onCancel}>
          Cancel
        </button>
        <span className="text-xs text-stone-500">Ctrl/⌘+Enter to save · Esc to cancel</span>
      </div>
    </div>
  );
}

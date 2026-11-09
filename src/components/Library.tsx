import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { db, deleteDoc } from '../lib/db';
import { ACCEPT, importFile, kindOf } from '../lib/importer';
import { openDoc } from '../lib/nav';
import { ocr, type OcrStatus } from '../lib/ocr';
import type { DocRecord } from '../lib/types';

function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function Library() {
  const docs = useLiveQuery(() => db.docs.orderBy('openedAt').reverse().toArray(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [usage, setUsage] = useState<string | null>(null);
  const [ocrStatus, setOcrStatus] = useState<OcrStatus>({ running: false });
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => ocr.subscribe(setOcrStatus), []);
  useEffect(() => {
    navigator.storage
      ?.estimate?.()
      .then((e) => e.usage != null && setUsage(formatBytes(e.usage)))
      .catch(() => {});
  }, [docs?.length]);

  async function handleFiles(files: FileList | File[]) {
    setError(null);
    const list = [...files];
    const bad = list.filter((f) => !kindOf(f));
    if (bad.length) setError(`Skipped unsupported file(s): ${bad.map((f) => f.name).join(', ')}. Use PDF, TXT or Markdown.`);
    let last: DocRecord | null = null;
    for (const f of list.filter((f) => kindOf(f))) {
      try {
        setBusy(`Importing ${f.name}…`);
        last = await importFile(f, (m) => setBusy(`${f.name}: ${m}`));
      } catch (e) {
        console.error(e);
        setError(`Could not import ${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBusy(null);
    if (last?.ocrPending) ocr.kick();
    if (last && list.length === 1) openDoc(last.id);
  }

  return (
    <div
      className="mx-auto min-h-full max-w-4xl px-4 py-10 sm:px-6"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
      }}
    >
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Read Aloud</h1>
          <p className="mt-1 text-stone-500 dark:text-stone-400">Your library. Everything stays in this browser.</p>
        </div>
        <button
          className="rounded-lg bg-sky-600 px-4 py-2 font-medium text-white shadow-sm hover:bg-sky-700 disabled:opacity-50"
          onClick={() => input.current?.click()}
          disabled={!!busy}
        >
          Add document
        </button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </header>

      {busy && <div className="mb-4 rounded-lg bg-sky-50 px-4 py-3 text-sky-900 dark:bg-sky-950 dark:text-sky-100">{busy}</div>}
      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-red-900 dark:bg-red-950 dark:text-red-100" role="alert">
          {error}
        </div>
      )}
      {ocrStatus.error && (
        <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {ocrStatus.error}{' '}
          <button className="underline" onClick={() => ocr.kick()}>
            Try again
          </button>
        </div>
      )}

      <div
        className={`mb-8 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging ? 'border-sky-500 bg-sky-50 dark:bg-sky-950' : 'border-stone-300 dark:border-stone-700'
        }`}
      >
        <p className="font-medium">Drop PDF, TXT or Markdown files here</p>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">Scanned PDFs are converted to text automatically (OCR).</p>
      </div>

      {docs === undefined ? null : docs.length === 0 ? (
        <p className="text-center text-stone-500 dark:text-stone-400">No documents yet.</p>
      ) : (
        <ul className="divide-y divide-stone-200 overflow-hidden rounded-xl border border-stone-200 bg-white dark:divide-stone-800 dark:border-stone-800 dark:bg-stone-900">
          {docs.map((d) => (
            <DocRow key={d.id} doc={d} ocrActive={ocrStatus.running && ocrStatus.docId === d.id} />
          ))}
        </ul>
      )}

      {usage && <p className="mt-4 text-right text-xs text-stone-400">Storage used: {usage}</p>}
    </div>
  );
}

function DocRow({ doc, ocrActive }: { doc: DocRecord; ocrActive: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(doc.title);
  const pct = Math.round(doc.progress * 100);

  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <span className="w-12 shrink-0 rounded bg-stone-100 py-1 text-center text-xs font-semibold uppercase text-stone-500 dark:bg-stone-800 dark:text-stone-400">
        {doc.kind}
      </span>
      <div className="min-w-0 flex-1">
        {renaming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void db.docs.update(doc.id, { title: title.trim() || doc.title });
              setRenaming(false);
            }}
          >
            <input
              autoFocus
              className="w-full rounded border border-stone-300 bg-transparent px-2 py-1 dark:border-stone-700"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={(e) => e.currentTarget.form?.requestSubmit()}
            />
          </form>
        ) : (
          <button className="block w-full truncate text-left font-medium hover:text-sky-700 dark:hover:text-sky-400" onClick={() => openDoc(doc.id)}>
            {doc.title}
          </button>
        )}
        <div className="mt-1 flex items-center gap-3 text-xs text-stone-500 dark:text-stone-400">
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
            <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
          </div>
          <span>{pct}%</span>
          {doc.kind === 'pdf' && <span>{doc.pageCount} pages</span>}
          {doc.ocrPending > 0 && (
            <span className="text-amber-700 dark:text-amber-400">
              {ocrActive ? 'Scanning text' : 'Waiting to scan'}: {doc.ocrPending} page{doc.ocrPending === 1 ? '' : 's'} left
            </span>
          )}
        </div>
      </div>
      <button className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-stone-100" onClick={() => setRenaming(true)}>
        Rename
      </button>
      <button
        className="text-sm text-stone-500 hover:text-red-600"
        onClick={() => {
          if (confirm(`Delete "${doc.title}" and its notes?`)) void deleteDoc(doc.id);
        }}
      >
        Delete
      </button>
    </li>
  );
}

# Read Aloud

A personal read-aloud app: open PDFs (including scanned textbooks) and text
files, listen at any speed in a choice of voices with follow-along
highlighting, and keep highlights and notes.

Works without an account: everything, including your files, notes and reading
positions, is stored in this browser (IndexedDB). Optional **Google sign-in**
syncs your library across computers. See [docs/SIGN_IN_SETUP.md](docs/SIGN_IN_SETUP.md).

See [docs/SCOPE.md](docs/SCOPE.md) for the full plan and roadmap.

## Run it

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Then open http://localhost:5173. Chrome or Edge on desktop is recommended.

Other commands: `npm test` (unit tests), `npm run build` (production build in `dist/`), `npm run preview` (serve the build).

## What works

- **Import** PDF, `.txt` and Markdown by button or drag-and-drop.
- **PDF cleanup:** joins wrapped lines into paragraphs, fixes words hyphenated
  across lines, detects headings, drops footnote numbers and sideways margin
  stamps (watermarks, arXiv IDs), and marks running headers/footers, page
  numbers and notices like "Distributed by…" or "Downloaded from…" so they
  aren't read. "Re-read text" in the library applies the latest cleanup to
  PDFs imported earlier.
- **Scanned PDFs:** pages without a text layer are converted with OCR
  (Tesseract, running in your browser) in the background, starting at the
  page you're reading. You can start listening right away; scanned pages
  fill in as they finish. The OCR engine is served by the app itself, not
  a CDN.
- **Listening:**
  - **Natural voices (Kokoro)**, generated in your browser, plus the browser's own voices.
  - Speed 0.5×–4× (slider, presets, `+`/`-` keys). Natural voices keep pitch and the gaps between words at any speed.
  - The current sentence and word are highlighted, and the view follows along.
  - Click any sentence to jump there. `Space` plays/pauses, `←`/`→` move one sentence back/forward.
  - Short pauses between sentences and longer ones between paragraphs.
  - Time left and words per minute at the current speed.
  - **Sleep timer:** stop after 5–60 minutes or at the end of the section.
  - Your reading position is saved for each document.
- **Skip clutter** (Skip menu in the reader): headers, footers and page
  numbers (also on scanned pages, tolerant of OCR typos), citations like `[12]` or
  `(Smith et al., 2020)`, web links and emails, figure/table captions,
  reference lists, and footnotes (small print in PDFs). Skipped text stays
  visible in grey.
- **Paragraph menu** (hover a paragraph and click ⋯, or right-click it):
  read from here, don't read this paragraph, don't read anything like it (in
  this document or in all documents, which is handy for footers the automatic
  cleanup misses), read a paragraph that was skipped automatically, and
  **edit text** to fix scan mistakes. Your choices are listed (with Undo) in
  the Skip menu.
- **Side panel:** **Contents** (headings or pages, with the current section
  marked), **Search** (results list; matches highlighted in the text),
  **Notes**, and **Pronounce**: teach the voice how to say words ("ATP" →
  "A T P"), with a "Try it" button. Selecting a word offers "Pronounce…".
- **Listening queue:** "+ Queue" documents in the library; when one ends the
  next starts automatically from where you left off.
- **Highlights and notes:** select text to highlight it in 4 colours, add a
  note, or start listening from there. Notes sidebar, click a note to jump
  to it, export everything as Markdown.
- **Library:** progress per document, OCR status, rename, delete, storage used.
- **Sign in with Google (optional):** syncs documents, extracted/OCR text,
  positions, highlights, notes, skip choices, pronunciations, queue and voice
  settings; backs up PDFs. Local-first: works offline, syncs in the background.

## Voices

**Natural voices (Kokoro)** are the default. They come from the open-source
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model, which runs
entirely in your browser:

- The model (~330 MB) downloads from Hugging Face the first time and is then cached by the browser.
- With a GPU (WebGPU in Chrome/Edge) generation is much faster than real time. On CPU it uses
  all cores but one; a typical desktop keeps up with fast playback. Upcoming sentences are
  generated ahead of time, and "Preparing audio…" shows if generation falls behind.
- Speed changes are applied to the audio itself, so voices stay clear when sped up.

**Browser voices** (Web Speech API) are also listed and need no download. In
Edge, the "Online (Natural)" voices are the best of these. Chrome's Google
voices get hard to understand above ~1.3×, so the app slows them down a bit.

## Hosting

The app is static files (`npm run build` → `dist/`). For natural voices to use
several CPU threads, serve it with these headers (already set for `npm run dev`
and `npm run preview`):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

## Project layout

```
src/
  lib/
    importer.ts     file import into the library
    pdf.ts          pdf.js loading, text extraction, page rendering
    pdfLayout.ts    lines → paragraphs, header/footer removal
    textImport.ts   .txt / Markdown → paragraphs
    segment.ts      sentence splitting
    ocr.ts          background OCR runner for scanned pages
    player.ts       playback: sentence queue, pauses, skips, sleep timer
    engines/        webSpeech.ts (browser voices), kokoro.ts + kokoro.worker.ts (natural voices)
    skip.ts         skip-clutter rules
    db.ts           IndexedDB storage (Dexie)
    sync.ts         local-first sync engine (change tracking, push/pull, tombstones)
    cloud.ts        Supabase client, Google sign-in, remote adapter
supabase/schema.sql   database table, security rules and file bucket for sync
  components/       Library, Reader, PlayerBar, NotesPanel, BlockView
scripts/copy-assets.mjs   copies the OCR engine, English data and ONNX runtime into public/
```

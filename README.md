# Read Aloud

A personal read-aloud app: open PDFs (including scanned textbooks) and text
files, listen at any speed in a choice of voices with follow-along
highlighting, and keep highlights and notes.

**MVP:** no sign-in, no server. Everything, including your files, notes and
reading positions, is stored in this browser (IndexedDB).

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
  across lines, drops running headers/footers and page numbers, detects headings.
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
- **Skip clutter** (Skip menu in the reader): citations like `[12]` or
  `(Smith et al., 2020)`, web links and emails, figure/table captions,
  reference lists, and footnotes (small print in PDFs). Skipped text stays
  visible in grey.
- **Highlights and notes:** select text to highlight it in 4 colours, add a
  note, or start listening from there. Notes sidebar, click a note to jump
  to it, export everything as Markdown.
- **Library:** progress per document, OCR status, rename, delete, storage used.

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
  components/       Library, Reader, PlayerBar, NotesPanel, BlockView
scripts/copy-assets.mjs   copies the OCR engine, English data and ONNX runtime into public/
```

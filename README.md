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
- **Listening** with the browser's built-in voices:
  - Speed 0.5×–4× (slider, presets, `+`/`-` keys).
  - Voice picker; natural-sounding voices listed first.
  - The current sentence and word are highlighted, and the view follows along.
  - Click any sentence to jump there. `Space` plays/pauses, `←`/`→` move one sentence back/forward.
  - Your reading position is saved for each document.
- **Highlights and notes:** select text to highlight it in 4 colours, add a
  note, or start listening from there. Notes sidebar, click a note to jump
  to it, export everything as Markdown.
- **Library:** progress per document, OCR status, rename, delete, storage used.

## Voices

The app uses the voices your browser and OS provide, at no cost.
**Microsoft Edge** includes very natural "Online (Natural)" voices, and
Chrome has "Google" voices. Some voices top out at about 2×–3× speed whatever
the setting.

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
    player.ts       speech playback (Web Speech API)
    db.ts           IndexedDB storage (Dexie)
  components/       Library, Reader, PlayerBar, NotesPanel, BlockView
scripts/copy-ocr-assets.mjs   copies the OCR engine + English data into public/ocr
```

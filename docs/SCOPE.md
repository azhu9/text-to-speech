# Project Scope: Read-Aloud App (Speechify-style)

A personal text-to-speech reader: open a PDF or text file, have it read aloud
at any speed in a choice of voices, follow along with highlighting, and keep
notes and highlights. AI question-answering comes later.

> Naming: this is our own app with similar features. We should give it its own
> name and look and not reuse Speechify's name, logo or design.

## Current status: MVP built (no sign-in)

The first version runs entirely in the browser with no account. It covers
M1 (text files read aloud), most of M2 (text PDFs; reflowed reader view
with page markers instead of the original-page view), the core of M3 (OCR
for scanned pages) and M4 (highlights and notes). See the README for details.

Since then: Kokoro natural voices (M5), skip-clutter options, and listening
extras (sleep timer, time left, words per minute).

Still to come: Google sign-in with sync (next), original-page view, and Ask AI (M6).

## Decisions so far

| Question | Answer | What it changes |
|---|---|---|
| Who uses it? | Just me, but with **Google sign-in** | Add Google login, restricted to my account. Data lives on a server so it follows the login. |
| Devices | **Mostly desktop** | Desktop-first layout; phone is "works, not polished". In-browser AI voices are practical on desktop GPUs. |
| Voice budget | **Free voices only** | Browser voices + Kokoro. No paid TTS. |
| Offline | Not required, nice to have | Online-first; offline mode is a late polish item. |
| Content | **PDF readings and scanned textbooks** | **OCR moves into v1.** Original-page view becomes the main view. |

---

## 1. Goals and non-goals

**Goals (v1)**
- Import **PDF** (text-based **and scanned**, via OCR) and **plain-text / Markdown** files.
- Read aloud with **adjustable speed** (0.5x–4x) and **several voices**.
- **Follow-along highlighting** of the sentence (and ideally word) being read.
- **Highlights and notes** tied to passages, kept between sessions.
- Remember **reading position** per document.
- Runs as a **web app**, desktop-first.
- **Sign in with Google**; library, notes and positions saved to my account.

**Later (v2+)**
- **Ask AI** about the document (Q&A, summaries, explain a passage).
- More formats: EPUB, DOCX, web pages (paste a URL), photos of pages.
- Offline mode (PWA caching).
- Offline audio export (MP3 of a document).

**Non-goals for now**
- Native iOS/Android apps (the web app can be installed as a PWA instead).
- Voice cloning, celebrity voices, browser extension, Chrome-wide reading.
- Multi-user / team features, payments.

---

## 2. Feature breakdown

### 2.1 Document import
| Item | Approach | Notes |
|---|---|---|
| `.txt`, `.md` | Read with `FileReader`; Markdown stripped to plain text for speech | Easy |
| PDF (text-based) | [`pdf.js`](https://mozilla.github.io/pdf.js/) to render pages and extract text | Main difficulty is cleanup (below) |
| PDF (scanned) | Detect pages with no text layer → OCR with `tesseract.js` in a background Web Worker | **v1** (see 2.1a) |
| EPUB / DOCX / URL | `epub.js`, `mammoth`, Readability | v2 |

**PDF text cleanup** is where most of the effort goes:
- Join words split by line-end hyphens (`infor-\nmation` → `information`).
- Join lines into paragraphs; keep real paragraph breaks.
- Drop repeated headers, footers and page numbers.
- Multi-column layouts can come out in the wrong order; v1 accepts some
  errors here and lets the user skip ahead.
- Optional "skip" rules: references, footnotes, citations like `[12]`.

Every document becomes one common structure that the rest of the app uses:

```ts
type Doc = {
  id: string;
  title: string;
  source: { kind: "pdf" | "txt" | "md"; fileName: string };
  blocks: Block[];          // paragraphs / headings, in reading order
};
type Block = {
  id: string;
  page?: number;            // for PDFs
  text: string;
  sentences: { start: number; end: number }[]; // char offsets in text
};
```

Splitting into sentences up front (`Intl.Segmenter`) is what makes
speech chunking, highlighting, notes and later the AI feature work cleanly.

### 2.1a OCR for scanned textbooks
Scanned PDFs are just pictures of pages; there is no text to read until OCR
turns the image into words.

- **Engine:** `tesseract.js` (free, open source, runs in the browser). Each
  word comes back with its **position on the page** (bounding box) and a
  confidence score. Those positions are what make highlighting on the
  original page possible.
- **Speed:** roughly a few seconds per page on a desktop, so a 400-page
  textbook takes tens of minutes. OCR runs in background workers, starting
  at the page you're reading and working outward, so you can start listening
  right away. Results are saved, so each page is only processed once.
- **Cleanup specific to scans:** straighten tilted pages, split two-page
  spreads, drop running headers/page numbers, skip figure/caption regions if
  confident, rejoin hyphenated words.
- **Quality:** expect occasional misread words (especially equations,
  tables, small print). A "fix this word" edit on the page view handles them.
- **Fallback (if quality isn't good enough):** run OCRmyPDF/Tesseract on the
  server at upload time, or try a newer open-source OCR model. Decide after
  testing on your real textbooks.

### 2.2 Text-to-speech engine
Built behind one interface so engines can be swapped:

```ts
interface TTSEngine {
  listVoices(): Promise<Voice[]>;
  speak(text: string, opts: { voice: string; rate: number }): Playback; // emits word/sentence boundary events
}
```

| Option | Quality | Cost | Word timing | Offline | Verdict |
|---|---|---|---|---|---|
| **Browser Web Speech API** | OK to good (depends on OS; Edge/Safari voices are decent) | Free | Yes (`boundary` events, patchy on some browsers) | Yes | **v1 baseline**: works on day one |
| **Kokoro-82M** (open source, Apache-2.0) | Very good, natural | Free | Not built in; sentence-level | Yes, runs in the browser (`kokoro-js`, WebGPU/WASM) or on a small server | **v1 "high quality" engine** |
| Piper (open source) | Good | Free | Not built in | Yes | Backup option |
| OpenAI TTS | Very good | Pay per character | No | No | Optional |
| ElevenLabs | Excellent | Most expensive | Yes (timestamps) | No | Optional premium |
| Azure / Google Cloud TTS | Very good, many voices | Pay per character, free tier | Yes (word timing) | No | Good if we want lots of voices + word timing |

**Recommendation:** ship with Web Speech API first (free, no backend), then add
Kokoro as the quality voice. Paid cloud voices stay optional plug-ins, so
there is no ongoing cost unless we choose it.

### 2.3 Playback and speed
- Speak **sentence by sentence** (or a few sentences per chunk). Short chunks
  start fast, make highlighting easy, and let us generate the next chunk
  while the current one plays.
- **Speed 0.5x–4x** in 0.1 steps, plus presets.
  - Web Speech: `utterance.rate`.
  - Generated audio: `audio.playbackRate` with `preservesPitch = true`, so
    speed changes are instant and don't need new audio.
- Controls: play/pause, back/forward one sentence, skip ±15 s,
  click any sentence to start reading from there, keyboard shortcuts.
- Remember position, voice and speed per document.
- Cache generated audio per sentence (IndexedDB) so re-listening is free.
- Media Session API: media keys / headphone buttons control playback.

### 2.4 Reader view and follow-along highlighting
Two ways to view a document (see section 6 for the full explanation):
1. **Original page view (main view, v1):** pdf.js renders the real page; the
   current sentence is drawn as a box over it, using word positions from the
   PDF text layer or from OCR. Best for scanned textbooks.
2. **Reader view (optional toggle):** clean reflowed text from `Doc.blocks`,
   adjustable font size, line spacing, dark mode. Used for `.txt`/`.md` and
   as an alternative for long text-only PDFs.

Highlighting levels:
- **Sentence** highlight: always available (we know which chunk is playing).
- **Word** highlight: from Web Speech `boundary` events or cloud timestamps;
  for Kokoro, estimated from word length within the sentence (good enough).
- Auto-scroll to keep the current sentence in view, paused while the user
  scrolls by hand.

### 2.5 Highlights and notes
- Select text → **Highlight** (a few colours) or **Add note**.
- Saved as an anchor into the document text:
  ```ts
  type Annotation = {
    id: string; docId: string;
    blockId: string; start: number; end: number; // char offsets
    quote: string;          // copied text, used to re-find the anchor if needed
    color?: string; note?: string;
    createdAt: number; updatedAt: number;
  };
  ```
- Sidebar listing all highlights/notes; click to jump there (and play from there).
- "Bookmark this sentence" while listening, without looking at the screen.
- Export notes and highlights as Markdown.
- Search inside the document.

### 2.6 Library, login and storage
- List of documents with title, progress %, last opened; delete / rename.
- **Google sign-in** via Supabase Auth, with an allow-list so only my Google
  account can log in.
- **Where data lives:**
  - Notes, highlights, reading positions, settings, OCR text → Supabase
    Postgres (small, syncs with the login).
  - The PDF files themselves → Supabase Storage. Scanned textbooks are big
    (often 50–300 MB each), so the free tier fills up after a handful of
    books. Options if that's a problem: keep PDFs only in this browser (OPFS)
    and sync just the notes, or store them in my own **Google Drive** (15 GB
    free) using the same Google login. Decide in M2.
  - Generated audio is cached in the browser only (it can be regenerated).

### 2.7 Ask AI (v2, but designed for now)
- Side panel: "Ask about this document", "Summarize this section",
  "Explain the highlighted text".
- Short documents: send the whole text with the question. Long documents:
  split into chunks (we already have blocks/sentences), find the relevant ones
  (embeddings or keyword search), send those.
- Answers cite the blocks they used, so you can click to jump there or have
  the answer read aloud.
- Uses an LLM API (e.g. Claude) through a small server endpoint so the
  API key is never in the browser.
- Groundwork done in v1: stable block IDs and clean text.

---

## 3. Proposed tech stack

| Layer | Choice | Why |
|---|---|---|
| App | **Next.js (React) + TypeScript** | One codebase for UI and later the small API routes the AI/cloud voices need |
| Styling | Tailwind CSS | Fast to build a clean reader UI |
| State | Zustand | Simple player/reader state |
| Auth + database + files | **Supabase** (Google OAuth, Postgres, Storage) | Free tier, Google login built in |
| Local cache | IndexedDB via Dexie / OPFS | Audio and page-image cache, faster reopen |
| OCR | `tesseract.js` in Web Workers | Free, in-browser, gives word positions |
| PDF | pdf.js (`pdfjs-dist`) | Standard, free, renders and extracts text |
| TTS | Web Speech API → Kokoro (`kokoro-js`) → optional cloud | Free first, quality next, paid only if wanted |
| Sentence split | `Intl.Segmenter` | Built into browsers |
| Hosting | Vercel / Netlify (static + API routes) | Free tier is enough |
| Tests | Vitest (logic), Playwright (end-to-end) | |

---

## 4. Milestones

| # | Milestone | Contents | Rough size |
|---|---|---|---|
| **M0** | Setup + login | Next.js + TS + Tailwind, Supabase project, Google sign-in restricted to my account, deploy, empty library | 1–2 days |
| **M1** | Read a text file aloud | Import `.txt`/`.md`, sentence split, reader view, browser voices, play/pause/skip, speed, voice picker, sentence highlight | 2–3 days |
| **M2** | Text PDFs in page view | pdf.js page rendering, text extraction + cleanup, highlight drawn on the page, upload/storage, library, saved position | 4–6 days |
| **M3** | Scanned textbooks (OCR) | Detect scanned pages, background OCR from current page outward, word boxes → on-page highlight, scan cleanup, fix-a-word | 5–8 days |
| **M4** | Highlights and notes | Select → highlight/note on the page, sidebar, jump to, export Markdown, search | 3–4 days |
| **M5** | Better free voices | Kokoro in browser (WebGPU), generate-ahead + audio cache, word highlight | 3–5 days |
| **M6** | Ask AI | Server endpoint, Q&A panel with citations, summarize / explain selection | 3–5 days |
| Later | Extras | Reader view toggle polish, offline mode, EPUB/DOCX/URL, MP3 export, mobile polish | — |

First usable version for your textbooks (M0–M4): roughly **3–4 weeks** of
focused work.

**Definition of done for v1:** sign in with Google, upload a scanned
textbook chapter, start listening within a minute at 2.5x in a natural
free voice, see the current sentence highlighted on the actual page, add
highlights and notes, and come back later (any computer) to the same spot.

---

## 5. Risks and unknowns

| Risk | Impact | Mitigation |
|---|---|---|
| Messy PDF text (columns, footnotes, tables) | Wrong reading order, odd speech | Cleanup rules, "skip" options, click-to-jump; accept imperfection in v1 |
| Web Speech voices differ a lot by browser/OS | Inconsistent quality | Kokoro as the consistent quality engine |
| Kokoro in-browser is slow on older phones | Gaps between sentences | Generate ahead while playing; WebGPU when available; small server fallback |
| Word timing not available for some engines | Only sentence highlight | Estimate word timing; sentence highlight is the guaranteed baseline |
| OCR errors on textbook scans (equations, tables, small print, bad scans) | Misread words, odd speech | Confidence filtering, skip low-confidence regions, fix-a-word, server OCR fallback |
| OCR is slow for whole books | Waiting before listening | Start at current page, process ahead in background, save results |
| Big scanned PDFs vs free storage limits | Storage fills up | Keep files local or in Google Drive; sync only notes/text |
| Mapping highlights onto the original page | Fiddly alignment | Use word boxes from pdf.js/OCR directly; sentence highlight as baseline |
| Browser storage limits / cleared data | Lost library | Export/backup button; later cloud sync |
| Cloud TTS / AI costs | Surprise bills | All paid services optional and behind our server with usage caps |

---

## 6. Open questions

1. **Main view** — original page view (recommended for scanned textbooks), reflowed reader view, or both with a toggle? See explanation in chat / below.
2. **Where should PDF files live** — Supabase Storage, this browser only, or your Google Drive?
3. **Sample files:** a couple of real textbook scans to test OCR quality early.
4. **Name** for the app?

### What "reader view vs. original page view" means
- **Original page view:** you see the actual PDF page (for a scan, the photo
  of the textbook page) with figures, equations and layout intact. The
  sentence being read is shown as a coloured box drawn over the page.
- **Reader view:** the app pulls the text out and shows it as a clean column
  of plain text, like a web article. You choose font size and spacing, but
  figures, tables, equations and page layout are gone, and any OCR mistakes
  are shown as text.
- For scanned textbooks, original page view is the better default: you keep
  the figures, and you can spot OCR errors against the real page. OCR gives
  us each word's position, so this costs little extra. Reader view is useful
  as an optional toggle for long text-only stretches.

## 7. Suggested next step

Start **M0 + M1**: project setup with Google sign-in, then get a `.txt` file
reading aloud with speed, voice choice and sentence highlighting. In
parallel, run `tesseract.js` on a few pages of your actual textbook scans to
check OCR quality before building M3 around it.

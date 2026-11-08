# Project Scope: Read-Aloud App (Speechify-style)

A personal text-to-speech reader: open a PDF or text file, have it read aloud
at any speed in a choice of voices, follow along with highlighting, and keep
notes and highlights. AI question-answering comes later.

> Naming: this is our own app with similar features. We should give it its own
> name and look and not reuse Speechify's name, logo or design.

---

## 1. Goals and non-goals

**Goals (v1)**
- Import **PDF** and **plain-text / Markdown** files.
- Read aloud with **adjustable speed** (0.5x–4x) and **several voices**.
- **Follow-along highlighting** of the sentence (and ideally word) being read.
- **Highlights and notes** tied to passages, kept between sessions.
- Remember **reading position** per document.
- Runs as a **web app** on desktop and phone browsers.

**Later (v2+)**
- **Ask AI** about the document (Q&A, summaries, explain a passage).
- More formats: EPUB, DOCX, web pages (paste a URL), images / scanned PDFs (OCR).
- Accounts and sync across devices.
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
| PDF (scanned) | OCR with `tesseract.js` | v2 |
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
- Media Session API: lock-screen / headphone controls on phones.

### 2.4 Reader view and follow-along highlighting
Two ways to view a document:
1. **Reader view (v1):** clean reflowed text from `Doc.blocks`, adjustable
   font size, line spacing, dark mode. Highlighting is simple here because we
   control the HTML.
2. **Original PDF view (v1.5):** pdf.js page rendering with its text layer,
   highlighting mapped onto the page. Harder because extracted text has to be
   mapped back to positions on the page.

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

### 2.6 Library
- List of imported documents with title, progress %, last opened.
- Delete / rename.
- Storage: files and data in the browser (**IndexedDB via Dexie**), so v1 needs
  no backend or account. Show storage usage; large PDFs can be big.

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
| Storage | IndexedDB via Dexie | Local-first, no account needed |
| PDF | pdf.js (`pdfjs-dist`) | Standard, free, renders and extracts text |
| TTS | Web Speech API → Kokoro (`kokoro-js`) → optional cloud | Free first, quality next, paid only if wanted |
| Sentence split | `Intl.Segmenter` | Built into browsers |
| Install on phone | PWA (manifest + service worker) | "App-like" without app stores |
| Hosting | Vercel / Netlify (static + API routes) | Free tier is enough |
| Tests | Vitest (logic), Playwright (end-to-end) | |

Later, for sync/accounts: Supabase (Postgres + auth + file storage).

---

## 4. Milestones

| # | Milestone | Contents | Rough size |
|---|---|---|---|
| **M0** | Project setup | Next.js + TS + Tailwind, lint/test, deploy pipeline, empty library page | 0.5–1 day |
| **M1** | Read a text file aloud | Import `.txt`/`.md`, sentence split, reader view, Web Speech playback, play/pause/skip, speed, voice picker, sentence highlight | 2–3 days |
| **M2** | PDFs | pdf.js import, text cleanup, page numbers, library + saved position | 3–5 days |
| **M3** | Highlights and notes | Select → highlight/note, sidebar, jump to, export Markdown, search | 3–4 days |
| **M4** | Better voices | Kokoro engine in browser, audio caching, word highlight estimate, Media Session controls | 3–5 days |
| **M5** | Polish | Original PDF view with highlighting, dark mode, font settings, keyboard shortcuts, PWA install, mobile layout | 4–6 days |
| **M6** | Ask AI | Server endpoint, Q&A panel with citations, summarize / explain selection | 3–5 days |
| Later | Extras | Cloud voices, EPUB/DOCX/URL, OCR, MP3 export, accounts + sync | — |

"Rough size" is focused working days for one developer; the first usable
version (M1–M3) is roughly **2 weeks**.

**Definition of done for v1 (M1–M4):** I can open a 50-page text-based PDF,
pick a natural-sounding voice, listen at 2.5x with the current sentence
highlighted, highlight and annotate passages, close the browser, and come back
to the same spot with my notes intact.

---

## 5. Risks and unknowns

| Risk | Impact | Mitigation |
|---|---|---|
| Messy PDF text (columns, footnotes, tables) | Wrong reading order, odd speech | Cleanup rules, "skip" options, click-to-jump; accept imperfection in v1 |
| Web Speech voices differ a lot by browser/OS | Inconsistent quality | Kokoro as the consistent quality engine |
| Kokoro in-browser is slow on older phones | Gaps between sentences | Generate ahead while playing; WebGPU when available; small server fallback |
| Word timing not available for some engines | Only sentence highlight | Estimate word timing; sentence highlight is the guaranteed baseline |
| Mapping highlights onto the original PDF page | Hard to get pixel-perfect | Ship reader view first; PDF view in M5 |
| Browser storage limits / cleared data | Lost library | Export/backup button; later cloud sync |
| Cloud TTS / AI costs | Surprise bills | All paid services optional and behind our server with usage caps |

---

## 6. Open questions (need your input)

1. **Who uses it?** Just you (local-first, no login), or others too (needs accounts, sync, hosting costs)?
2. **Devices:** mainly desktop browser, phone, or both equally?
3. **Voice budget:** free/open-source voices only, or are you open to paying for premium cloud voices (ElevenLabs/Azure-level)?
4. **Offline:** does it need to work without internet (e.g. on a plane)?
5. **PDF types:** mostly papers/textbooks (columns, footnotes), ebooks, or scanned documents?
6. **Reader view vs. original PDF look:** is reflowed text OK at first, or must highlights appear on the original page from day one?
7. **Name** for the app?

## 7. Suggested next step

Start **M0 + M1**: set up the Next.js project and get a `.txt` file reading
aloud with speed control, voice choice and sentence highlighting. That proves
the core loop end to end in a couple of days, and everything else builds on it.

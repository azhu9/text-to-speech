import { isKokoroVoice, kokoro } from './engines/kokoro';
import type { SpeechEngine, Utterance } from './engines/types';
import { WebSpeechEngine } from './engines/webSpeech';
import { applySkips, inlineSkips, skippedBlocks, type SkipOptions } from './skip';
import type { Block, Position } from './types';

export { engineRate, isGoogleOnlineVoice } from './engines/webSpeech';

export interface PlayItem {
  blockId: string;
  sentence: number;
  /** sentence start within block text */
  offset: number;
  /** the sentence as written */
  text: string;
  /** what is actually said (skipped parts removed) */
  speak: string;
  /** speak index -> text index */
  map: number[];
  words: number;
  /** first sentence of a heading block (chapter/section start) */
  heading: boolean;
}

export type SleepTimer = { kind: 'minutes'; endsAt: number; minutes: number } | { kind: 'chapter' } | null;

export interface PlayerState {
  playing: boolean;
  index: number;
  /** current word as [start, end) within the current block's text */
  word: [number, number] | null;
  rate: number;
  voiceURI: string | null;
  error: string | null;
  total: number;
  /** waiting for audio to be generated */
  buffering: boolean;
  sleep: SleepTimer;
}

const HAS_WORD = /[\p{L}\p{N}]/u;

export function buildItems(blocks: Block[], skip?: SkipOptions): PlayItem[] {
  const items: PlayItem[] = [];
  const skippedIds = skip ? skippedBlocks(blocks, skip) : new Set<string>();
  for (const b of blocks) {
    if (skippedIds.has(b.id)) continue;
    const ranges = skip ? inlineSkips(b.text, skip) : [];
    b.sentences.forEach(([s, e], i) => {
      const text = b.text.slice(s, e);
      const local = ranges
        .filter(([a, z]) => z > s && a < e)
        .map(([a, z]): [number, number] => [Math.max(0, a - s), Math.min(e - s, z - s)]);
      const { speak, map } = applySkips(text, local);
      if (!HAS_WORD.test(speak)) return;
      items.push({
        blockId: b.id,
        sentence: i,
        offset: s,
        text,
        speak,
        map,
        words: speak.split(/\s+/).filter(Boolean).length,
        heading: !!b.heading && i === 0,
      });
    });
  }
  return items;
}

export const MIN_RATE = 0.5;
export const MAX_RATE = 4;
export const clampRate = (r: number) => Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, r)) * 10) / 10;

/** Typical words per minute at 1x, for time estimates. */
export const BASE_WPM = 165;

const SETTINGS_KEY = 'read-aloud:player';
/** Wait this long after the last speed/voice change before speaking again. */
const RESTART_DELAY_MS = 300;
const SENTENCE_PAUSE_MS = 250;
const PARAGRAPH_PAUSE_MS = 600;
/** How many upcoming sentences to have audio generated for. */
const LOOKAHEAD = 4;

function loadSettings(): { rate: number; voiceURI: string | null } {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return { rate: typeof v.rate === 'number' ? clampRate(v.rate) : 1, voiceURI: v.voiceURI ?? null };
  } catch {
    return { rate: 1, voiceURI: null };
  }
}

function saveSettings(rate: number, voiceURI: string | null) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ rate, voiceURI }));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Reads a list of sentences aloud, one sentence per utterance, using either
 * the browser's voices or Kokoro depending on the chosen voice.
 */
export class SpeechPlayer {
  readonly web = new WebSpeechEngine();
  private items: PlayItem[] = [];
  private listeners = new Set<() => void>();
  private token = 0;
  private handle: Utterance | null = null;
  /** handle is paused in place and can be resumed */
  private heldPaused = false;
  /** char offset (in item.speak) to start from next time */
  private resumeChar = 0;
  private lastWordChar = 0;
  private endedAtLast = false;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private gapTimer?: ReturnType<typeof setTimeout>;
  private sleepTimer?: ReturnType<typeof setTimeout>;
  private warmTimer?: ReturnType<typeof setTimeout>;
  state: PlayerState;

  constructor() {
    const s = loadSettings();
    this.state = {
      playing: false,
      index: 0,
      word: null,
      rate: s.rate,
      voiceURI: s.voiceURI,
      error: null,
      total: 0,
      buffering: false,
      sleep: null,
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getState = () => this.state;

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  setVoices(voices: SpeechSynthesisVoice[]) {
    this.web.voices = voices;
  }

  private get engine(): SpeechEngine {
    return isKokoroVoice(this.state.voiceURI) ? kokoro : this.web;
  }

  get current(): PlayItem | undefined {
    return this.items[this.state.index];
  }

  get position(): Position | undefined {
    const it = this.current;
    return it && { blockId: it.blockId, sentence: it.sentence };
  }

  /** Words left from the current sentence to the end. */
  wordsRemaining(): number {
    let n = 0;
    for (let i = this.state.index; i < this.items.length; i++) n += this.items[i].words;
    return n;
  }

  /** Replace the sentence list (OCR finished a page, skip settings changed), keeping the current place. */
  setItems(items: PlayItem[], start?: Position) {
    const keep = start ?? this.position;
    const sameSentence = (it: PlayItem | undefined) => !!it && !!keep && it.blockId === keep.blockId && it.sentence === keep.sentence;
    const old = this.current;
    this.items = items;
    let index = 0;
    if (keep) {
      const i = items.findIndex(sameSentence);
      // Sentence vanished (e.g. now skipped): go to the next one after it.
      const j = i >= 0 ? i : this.indexAtOrAfter(keep);
      index = j >= 0 ? j : Math.max(0, items.length - 1);
    }
    const changed = index !== this.state.index || this.current?.speak !== old?.speak;
    this.set({ index, total: items.length, ...(changed ? { word: null } : {}) });
    if (!this.state.playing) this.warmUp();
    if (changed && this.state.playing) {
      // What's being said changed underneath us: restart cleanly.
      this.resumeChar = 0;
      this.speakCurrent();
    } else if (this.state.playing) {
      this.prefetch();
    }
  }

  play() {
    if (!this.items.length) return;
    clearTimeout(this.restartTimer);
    if (this.endedAtLast) {
      this.endedAtLast = false;
      this.set({ index: 0 });
    }
    this.set({ playing: true, error: null });
    if (this.heldPaused && this.handle?.resume) {
      this.heldPaused = false;
      this.handle.resume();
      return;
    }
    this.speakCurrent();
  }

  pause() {
    clearTimeout(this.restartTimer);
    clearTimeout(this.gapTimer);
    if (this.handle?.pause && !this.heldPaused) {
      this.handle.pause();
      this.heldPaused = true;
    } else if (this.handle) {
      this.resumeChar = this.lastWordChar;
      this.stopUtterance();
    }
    this.set({ playing: false, buffering: false });
  }

  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  /** Jump to a sentence; keeps playing if already playing. */
  seek(index: number) {
    const i = Math.max(0, Math.min(this.items.length - 1, index));
    this.stopUtterance();
    this.resumeChar = 0;
    this.lastWordChar = 0;
    this.endedAtLast = false;
    this.set({ index: i, word: null });
    if (this.state.playing) {
      clearTimeout(this.restartTimer);
      this.speakCurrent();
    } else this.warmUp();
  }

  /** Index of this sentence, or of the first one after it if it is skipped. */
  private indexAtOrAfter(pos: Position): number {
    const [kp, kb] = pos.blockId.split('-').map(Number);
    return this.items.findIndex((it) => {
      const [p, b] = it.blockId.split('-').map(Number);
      return p > kp || (p === kp && (b > kb || (b === kb && it.sentence >= pos.sentence)));
    });
  }

  seekTo(pos: Position, play = false) {
    const i = this.indexAtOrAfter(pos);
    if (i < 0) return;
    this.seek(i);
    if (play && !this.state.playing) this.play();
  }

  next() {
    this.seek(this.state.index + 1);
  }

  prev() {
    // Like a music player: restart the sentence unless we're at its start.
    if (this.lastWordChar > 0) this.seek(this.state.index);
    else this.seek(this.state.index - 1);
  }

  setRate(rate: number) {
    const r = clampRate(rate);
    if (r === this.state.rate) return;
    this.set({ rate: r });
    saveSettings(r, this.state.voiceURI);
    if (this.handle?.setRate) this.handle.setRate(r); // audio engines change speed in place
    else this.scheduleRestart();
  }

  setVoice(voiceURI: string | null) {
    if (voiceURI === this.state.voiceURI) return;
    this.set({ voiceURI, error: null });
    saveSettings(this.state.rate, voiceURI);
    if (this.heldPaused) {
      this.resumeChar = this.lastWordChar;
      this.stopUtterance();
    }
    if (this.state.playing) this.scheduleRestart();
    else this.warmUp();
  }

  /** Stop after `minutes`, at the end of the current chapter, or never (null). */
  setSleep(timer: { kind: 'minutes'; minutes: number } | { kind: 'chapter' } | null) {
    clearTimeout(this.sleepTimer);
    if (!timer) return this.set({ sleep: null });
    if (timer.kind === 'chapter') return this.set({ sleep: { kind: 'chapter' } });
    const endsAt = Date.now() + timer.minutes * 60_000;
    this.set({ sleep: { kind: 'minutes', minutes: timer.minutes, endsAt } });
    this.sleepTimer = setTimeout(() => {
      this.set({ sleep: null });
      if (this.state.playing) this.pause();
    }, timer.minutes * 60_000);
  }

  destroy() {
    clearTimeout(this.restartTimer);
    clearTimeout(this.warmTimer);
    clearTimeout(this.sleepTimer);
    this.stopUtterance();
    this.listeners.clear();
  }

  /**
   * Speed/voice changes arrive in bursts (dragging the slider). Stop right
   * away, but only start again once the changes settle.
   */
  private scheduleRestart() {
    if (!this.state.playing) return;
    if (this.handle) this.resumeChar = this.lastWordChar;
    this.stopUtterance();
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (this.state.playing) this.speakCurrent();
    }, RESTART_DELAY_MS);
  }

  private stopUtterance() {
    this.token++;
    clearTimeout(this.gapTimer);
    this.handle?.stop();
    this.handle = null;
    this.heldPaused = false;
  }

  private prefetch(includeCurrent = false) {
    const voiceId = this.state.voiceURI;
    if (!voiceId || !this.engine.prefetch) return;
    const from = this.state.index + (includeCurrent ? 0 : 1);
    const next = this.items.slice(from, this.state.index + 1 + LOOKAHEAD).map((it) => it.speak);
    this.engine.prefetch(next, voiceId);
  }

  /** While paused, get audio for the next few sentences ready so play starts instantly. */
  private warmUp() {
    clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => {
      if (!this.state.playing) this.prefetch(true);
    }, 400);
  }

  private speakCurrent() {
    this.stopUtterance();
    const t = this.token;
    const item = this.current;
    if (!item) {
      this.set({ playing: false });
      return;
    }
    const from = Math.min(this.resumeChar, item.speak.length);
    this.resumeChar = 0;
    this.lastWordChar = from;
    this.set({ word: from ? this.state.word : null });
    const voiceId = this.state.voiceURI ?? '';
    this.handle = this.engine.speak(
      item.speak.slice(from),
      { voiceId, rate: this.state.rate },
      {
        onStart: () => {
          if (t === this.token) this.set({ buffering: false });
        },
        onBuffering: (waiting) => {
          if (t === this.token) this.set({ buffering: waiting });
        },
        onWord: (i, len) => {
          if (t !== this.token) return;
          const s = from + i;
          const e = Math.min(item.speak.length, s + Math.max(1, len));
          this.lastWordChar = s;
          this.set({ word: [item.offset + item.map[s], item.offset + item.map[e - 1] + 1] });
        },
        onEnd: () => {
          if (t === this.token) this.advance(t);
        },
        onError: (message) => {
          if (t !== this.token) return;
          this.resumeChar = this.lastWordChar;
          this.stopUtterance();
          this.set({ playing: false, buffering: false, error: message });
        },
      },
    );
    this.prefetch();
  }

  private advance(t: number) {
    if (t !== this.token) return;
    this.handle = null;
    this.lastWordChar = 0;
    const cur = this.current;
    const next = this.items[this.state.index + 1];
    if (!next) {
      this.endedAtLast = true;
      this.set({ playing: false, word: null });
      return;
    }
    // Move the position now, so pausing during the gap resumes at the next sentence.
    this.set({ index: this.state.index + 1, word: null });
    if (this.state.sleep?.kind === 'chapter' && next.heading) {
      this.set({ playing: false, sleep: null });
      return;
    }
    // Breathe between sentences, a bit longer between paragraphs.
    const base = cur && next.blockId !== cur.blockId ? PARAGRAPH_PAUSE_MS : SENTENCE_PAUSE_MS;
    const gap = base / Math.sqrt(Math.max(1, this.state.rate));
    this.gapTimer = setTimeout(() => {
      if (t === this.token) this.speakCurrent();
    }, gap);
  }
}

import type { Block, Position } from './types';

export interface PlayItem {
  blockId: string;
  sentence: number;
  /** sentence start within block text */
  offset: number;
  text: string;
}

export interface PlayerState {
  playing: boolean;
  index: number;
  /** current word as [start, end) within the current block's text */
  word: [number, number] | null;
  rate: number;
  voiceURI: string | null;
  error: string | null;
  total: number;
}

export function buildItems(blocks: Block[]): PlayItem[] {
  const items: PlayItem[] = [];
  for (const b of blocks) {
    b.sentences.forEach(([s, e], i) => items.push({ blockId: b.id, sentence: i, offset: s, text: b.text.slice(s, e) }));
  }
  return items;
}

/** Chrome's online Google voices speed up far more than the rate suggests and
 * run words together above ~1.3x, so they get a gentler curve. */
export function isGoogleOnlineVoice(v: SpeechSynthesisVoice | undefined): boolean {
  return !!v && /^Google/i.test(v.name) && !v.localService;
}

/** The rate actually given to the speech engine for a chosen speed. */
export function engineRate(voice: SpeechSynthesisVoice | undefined, speed: number): number {
  if (!isGoogleOnlineVoice(voice) || speed <= 1) return speed;
  return Math.min(1.8, 1 + (speed - 1) * 0.35);
}

export const MIN_RATE = 0.5;
export const MAX_RATE = 4;
export const clampRate = (r: number) => Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, r)) * 10) / 10;

const SETTINGS_KEY = 'read-aloud:player';

/** Wait this long after the last speed/voice change before speaking again. */
const RESTART_DELAY_MS = 300;
/** Pause after cancel() before speak(); Chrome can drop speech queued immediately. */
const AFTER_CANCEL_MS = 120;
/** If an utterance hasn't started by then, the engine is stuck. */
const START_TIMEOUT_MS = 3000;
const STALL_AFTER_WORD_MS = 4000;
const MAX_RETRIES = 2;
/** Typical speaking speed at rate 1, used to estimate how long a sentence takes. */
const CHARS_PER_SEC = 14;
const SENTENCE_PAUSE_MS = 250;
const PARAGRAPH_PAUSE_MS = 600;

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
 * Reads a list of sentences aloud with the browser's Web Speech API.
 * Speaks one sentence per utterance; pausing / changing speed or voice
 * restarts from the last spoken word, which is more reliable across
 * browsers than speechSynthesis.pause()/resume().
 */
export class SpeechPlayer {
  private items: PlayItem[] = [];
  private listeners = new Set<() => void>();
  private token = 0;
  private resumeChar = 0;
  private lastWordChar = 0;
  /** Kept referenced so Chrome does not garbage-collect it mid-speech and drop its events. */
  utterance: SpeechSynthesisUtterance | null = null;
  private voices: SpeechSynthesisVoice[] = [];
  private endedAtLast = false;
  private cancelledAt = 0;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private gapTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  state: PlayerState;

  constructor() {
    const s = loadSettings();
    this.state = { playing: false, index: 0, word: null, rate: s.rate, voiceURI: s.voiceURI, error: null, total: 0 };
  }

  static get supported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
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
    this.voices = voices;
  }

  get voice(): SpeechSynthesisVoice | undefined {
    return this.voices.find((v) => v.voiceURI === this.state.voiceURI);
  }

  get current(): PlayItem | undefined {
    return this.items[this.state.index];
  }

  get position(): Position | undefined {
    const it = this.current;
    return it && { blockId: it.blockId, sentence: it.sentence };
  }

  /** Replace the sentence list (e.g. OCR finished a page), keeping the current place. */
  setItems(items: PlayItem[], start?: Position) {
    const keep = start ?? this.position;
    this.items = items;
    let index = 0;
    if (keep) {
      const i = items.findIndex((it) => it.blockId === keep.blockId && it.sentence === keep.sentence);
      if (i >= 0) index = i;
      else {
        // Block vanished or changed: go to the first sentence at or after it.
        const [kp, kb] = keep.blockId.split('-').map(Number);
        const j = items.findIndex((it) => {
          const [p, b] = it.blockId.split('-').map(Number);
          return p > kp || (p === kp && b >= kb);
        });
        index = j >= 0 ? j : Math.max(0, items.length - 1);
      }
    }
    const moved = index !== this.state.index;
    this.set({ index, total: items.length, ...(moved ? { word: null } : {}) });
  }

  play() {
    if (!SpeechPlayer.supported) {
      this.set({ error: 'This browser does not support speech synthesis.' });
      return;
    }
    if (!this.items.length) return;
    if (this.endedAtLast) {
      // Finished the document: start over.
      this.endedAtLast = false;
      this.set({ index: 0 });
    }
    clearTimeout(this.restartTimer);
    this.set({ playing: true, error: null });
    this.speakCurrent();
  }

  pause() {
    clearTimeout(this.restartTimer);
    if (this.utterance) this.resumeChar = this.lastWordChar;
    this.stopSpeech();
    this.set({ playing: false });
  }

  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  /** Jump to a sentence; keeps playing if already playing. */
  seek(index: number, char = 0) {
    const i = Math.max(0, Math.min(this.items.length - 1, index));
    this.resumeChar = char;
    this.lastWordChar = char;
    this.endedAtLast = false;
    this.set({ index: i, word: null });
    if (this.state.playing) {
      clearTimeout(this.restartTimer);
      this.speakCurrent();
    }
  }

  seekTo(pos: Position, play = false) {
    const i = this.items.findIndex((it) => it.blockId === pos.blockId && it.sentence === pos.sentence);
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
    this.scheduleRestart();
  }

  setVoice(voiceURI: string | null) {
    if (voiceURI === this.state.voiceURI) return;
    this.set({ voiceURI });
    saveSettings(this.state.rate, voiceURI);
    this.scheduleRestart();
  }

  destroy() {
    clearTimeout(this.restartTimer);
    this.stopSpeech();
    this.listeners.clear();
  }

  /**
   * Speed/voice changes arrive in bursts (dragging the slider). Stop speaking
   * right away, but only start again once the changes settle: hammering
   * cancel()+speak() is what jams Chrome's speech engine.
   */
  private scheduleRestart() {
    if (!this.state.playing) return;
    if (this.utterance) this.resumeChar = this.lastWordChar;
    this.stopSpeech();
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (this.state.playing) this.speakCurrent();
    }, RESTART_DELAY_MS);
  }

  private stopSpeech() {
    this.token++;
    this.utterance = null;
    clearTimeout(this.startTimer);
    clearTimeout(this.gapTimer);
    clearInterval(this.watchdog);
    if (!SpeechPlayer.supported) return;
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending) {
      synth.cancel();
      this.cancelledAt = Date.now();
    }
  }

  private speakCurrent(attempt = 0) {
    this.stopSpeech();
    const t = this.token;
    const item = this.current;
    if (!item) {
      this.set({ playing: false });
      return;
    }
    const from = this.resumeChar;
    this.resumeChar = 0;
    this.lastWordChar = from;
    const text = item.text.slice(from);
    if (!text.trim()) {
      this.advance(t);
      return;
    }
    const synth = window.speechSynthesis;
    const u = new SpeechSynthesisUtterance(text);
    const voice = this.voices.find((v) => v.voiceURI === this.state.voiceURI);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = engineRate(voice, this.state.rate);

    let started = false;
    let sawBoundary = false;
    let lastEvent = 0;
    const startedAt = { at: 0 };

    u.onstart = () => {
      if (t !== this.token) return;
      started = true;
      lastEvent = startedAt.at = Date.now();
    };
    u.onboundary = (e) => {
      if (t !== this.token || (e.name && e.name !== 'word')) return;
      started = sawBoundary = true;
      lastEvent = Date.now();
      const s = from + e.charIndex;
      const len = e.charLength || /^[^\s]+/.exec(item.text.slice(s))?.[0].length || 0;
      this.lastWordChar = s;
      this.set({ word: [item.offset + s, item.offset + s + len] });
    };
    u.onend = () => {
      if (t === this.token) this.advance(t);
    };
    u.onerror = (e) => {
      if (t !== this.token || e.error === 'interrupted' || e.error === 'canceled') return;
      if (attempt < MAX_RETRIES) {
        this.resumeChar = this.lastWordChar;
        this.cancelledAt = Date.now();
        this.speakCurrent(attempt + 1);
      } else {
        this.set({ playing: false, error: `Speech error: ${e.error}. Press play to try again.` });
      }
    };
    this.utterance = u; // keep a reference: Chrome can drop events of GC'd utterances
    this.set({ word: from ? this.state.word : null });

    // Rough upper bound for how long this chunk should take to say.
    const expectedMs = (text.length / (CHARS_PER_SEC * Math.min(this.state.rate, u.rate * 1.5))) * 1000;
    const keepAlive = isGoogleOnlineVoice(voice);
    let lastKeepAlive = Date.now();

    const begin = () => {
      if (t !== this.token) return;
      if (synth.paused) synth.resume(); // a paused engine silently queues everything
      synth.speak(u);
      const queuedAt = Date.now();
      this.watchdog = setInterval(() => {
        if (t !== this.token) return;
        const now = Date.now();
        if (!started) {
          // Engine never started this utterance: it's jammed. Kick it and retry once.
          if (now - queuedAt > START_TIMEOUT_MS) {
            this.resumeChar = from;
            if (attempt < MAX_RETRIES) {
              synth.cancel();
              this.cancelledAt = Date.now();
              this.speakCurrent(attempt + 1);
            } else {
              this.stopSpeech();
              this.set({ playing: false, error: 'The speech engine stopped responding. Press play to try again.' });
            }
          }
          return;
        }
        // Chrome's online Google voices go silent after ~15 s unless nudged.
        if (keepAlive && now - lastKeepAlive > 10_000 && synth.speaking) {
          synth.pause();
          synth.resume();
          lastKeepAlive = now;
        }
        // Started but no end event long after it should have finished: stalled.
        const quiet = now - lastEvent;
        const limit = sawBoundary ? STALL_AFTER_WORD_MS + expectedMs * 0.5 : expectedMs * 2 + STALL_AFTER_WORD_MS;
        if (quiet > limit) {
          if (sawBoundary && attempt < MAX_RETRIES) {
            this.resumeChar = this.lastWordChar;
            this.speakCurrent(attempt + 1);
          } else {
            this.advance(t);
          }
        }
      }, 500);
    };
    // Give the engine a moment after a cancel() before queueing new speech.
    const sinceCancel = Date.now() - this.cancelledAt;
    if (sinceCancel < AFTER_CANCEL_MS) this.startTimer = setTimeout(begin, AFTER_CANCEL_MS - sinceCancel);
    else begin();
  }

  private advance(t: number) {
    if (t !== this.token) return;
    clearInterval(this.watchdog);
    this.utterance = null;
    this.lastWordChar = 0;
    const cur = this.current;
    const next = this.items[this.state.index + 1];
    if (!next) {
      this.endedAtLast = true;
      this.set({ playing: false, word: null });
      return;
    }
    // Breathe between sentences, a bit longer between paragraphs.
    const base = cur && next.blockId !== cur.blockId ? PARAGRAPH_PAUSE_MS : SENTENCE_PAUSE_MS;
    const gap = base / Math.sqrt(Math.max(1, this.state.rate));
    // Move the position now, so pausing during the gap resumes at the next sentence.
    this.set({ index: this.state.index + 1, word: null });
    this.gapTimer = setTimeout(() => {
      if (t === this.token) this.speakCurrent();
    }, gap);
  }
}

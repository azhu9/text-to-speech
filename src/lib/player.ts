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

export const MIN_RATE = 0.5;
export const MAX_RATE = 4;
export const clampRate = (r: number) => Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, r)) * 10) / 10;

const SETTINGS_KEY = 'read-aloud:player';

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
    this.set({ playing: true, error: null });
    this.speakCurrent();
  }

  pause() {
    this.resumeChar = this.lastWordChar;
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
    if (this.state.playing) this.speakCurrent();
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
    this.set({ rate: r });
    saveSettings(r, this.state.voiceURI);
    this.restartFromWord();
  }

  setVoice(voiceURI: string | null) {
    this.set({ voiceURI });
    saveSettings(this.state.rate, voiceURI);
    this.restartFromWord();
  }

  destroy() {
    this.stopSpeech();
    this.listeners.clear();
  }

  private restartFromWord() {
    if (!this.state.playing) return;
    this.resumeChar = this.lastWordChar;
    this.speakCurrent();
  }

  private stopSpeech() {
    this.token++;
    this.utterance = null;
    if (SpeechPlayer.supported) window.speechSynthesis.cancel();
  }

  private speakCurrent() {
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
    const u = new SpeechSynthesisUtterance(text);
    const voice = this.voices.find((v) => v.voiceURI === this.state.voiceURI);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = this.state.rate;
    u.onboundary = (e) => {
      if (t !== this.token || (e.name && e.name !== 'word')) return;
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
      this.set({ playing: false, error: `Speech error: ${e.error}` });
    };
    this.utterance = u; // keep a reference: Chrome can drop events of GC'd utterances
    this.set({ word: from ? this.state.word : null });
    window.speechSynthesis.speak(u);
  }

  private advance(t: number) {
    if (t !== this.token) return;
    this.lastWordChar = 0;
    if (this.state.index + 1 < this.items.length) {
      this.set({ index: this.state.index + 1, word: null });
      this.speakCurrent();
    } else {
      this.endedAtLast = true;
      this.set({ playing: false, word: null });
    }
  }
}

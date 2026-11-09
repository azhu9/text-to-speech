import type { WorkerRequest, WorkerResponse } from './kokoro.worker';
import type { EngineCallbacks, SpeakOptions, SpeechEngine, Utterance } from './types';

export const KOKORO_PREFIX = 'kokoro:';

export interface KokoroVoice {
  id: string;
  name: string;
  accent: 'US' | 'UK';
  gender: 'female' | 'male';
}

/** The better-rated Kokoro v1.0 English voices. */
export const KOKORO_VOICES: KokoroVoice[] = [
  { id: 'af_heart', name: 'Heart', accent: 'US', gender: 'female' },
  { id: 'af_bella', name: 'Bella', accent: 'US', gender: 'female' },
  { id: 'af_nicole', name: 'Nicole', accent: 'US', gender: 'female' },
  { id: 'af_aoede', name: 'Aoede', accent: 'US', gender: 'female' },
  { id: 'af_kore', name: 'Kore', accent: 'US', gender: 'female' },
  { id: 'af_sarah', name: 'Sarah', accent: 'US', gender: 'female' },
  { id: 'am_michael', name: 'Michael', accent: 'US', gender: 'male' },
  { id: 'am_fenrir', name: 'Fenrir', accent: 'US', gender: 'male' },
  { id: 'am_puck', name: 'Puck', accent: 'US', gender: 'male' },
  { id: 'bf_emma', name: 'Emma', accent: 'UK', gender: 'female' },
  { id: 'bf_isabella', name: 'Isabella', accent: 'UK', gender: 'female' },
  { id: 'bm_george', name: 'George', accent: 'UK', gender: 'male' },
  { id: 'bm_fable', name: 'Fable', accent: 'UK', gender: 'male' },
];

export const DEFAULT_KOKORO_VOICE = KOKORO_PREFIX + 'af_heart';
export const isKokoroVoice = (voiceId: string | null | undefined) => !!voiceId?.startsWith(KOKORO_PREFIX);

export interface KokoroStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  /** 0..1 while downloading */
  progress: number;
  device?: string;
  error?: string;
}

interface Clip {
  url: string;
  duration: number;
}

interface Job {
  key: string;
  text: string;
  voice: string;
  priority: boolean;
  resolve(c: Clip): void;
  reject(e: Error): void;
}

const CACHE_SIZE = 60;

/** Spread the clip's duration over its words, weighting by length and
 * adding time for pauses at punctuation. Returns [start, length, startFraction]. */
export function estimateWordTimings(text: string): [number, number, number][] {
  const words = [...text.matchAll(/\S+/g)];
  const weight = (w: string) => w.length + 1.5 + (/[.!?;:]["')\]]*$/.test(w) ? 4 : /,["')\]]*$/.test(w) ? 2 : 0);
  const total = words.reduce((s, m) => s + weight(m[0]), 0) || 1;
  let acc = 0;
  return words.map((m) => {
    const at = acc / total;
    acc += weight(m[0]);
    return [m.index!, m[0].length, at];
  });
}

/**
 * Natural voices from the open-source Kokoro model, run in a Web Worker.
 * Sentences are generated ahead of time and played as audio, so speed changes
 * are done by the audio element (pitch preserved, gaps between words intact).
 */
export class KokoroEngine implements SpeechEngine {
  status: KokoroStatus = { state: 'idle', progress: 0 };
  private listeners = new Set<() => void>();
  private worker: Worker | null = null;
  private files = new Map<string, [number, number]>();
  private cache = new Map<string, Promise<Clip>>();
  private queue: Job[] = [];
  private inflight: (Job & { id: number }) | null = null;
  private nextId = 1;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getStatus = () => this.status;

  private setStatus(s: Partial<KokoroStatus>) {
    this.status = { ...this.status, ...s };
    this.listeners.forEach((l) => l());
  }

  /** Start downloading/loading the model (cached by the browser after the first time). */
  load(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    this.ready.catch(() => {});
    this.setStatus({ state: 'loading', progress: 0, error: undefined });
    if (!this.worker) {
      this.worker = new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
      this.worker.onerror = (e) => this.fail(e.message || 'The voice engine crashed.');
    }
    const ortBase = new URL(`${import.meta.env.BASE_URL}ort/`, window.location.href).href;
    this.post({ type: 'load', ortBase });
    return this.ready;
  }

  private post(m: WorkerRequest) {
    this.worker?.postMessage(m);
  }

  private fail(message: string) {
    this.setStatus({ state: 'error', error: message });
    this.readyReject?.(new Error(message));
    this.ready = null;
    const err = new Error(message);
    this.inflight?.reject(err);
    this.inflight = null;
    for (const j of this.queue.splice(0)) j.reject(err);
    this.cache.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private onMessage(m: WorkerResponse) {
    switch (m.type) {
      case 'progress': {
        this.files.set(m.file, [m.loaded, m.total]);
        let loaded = 0;
        let total = 0;
        for (const [l, t] of this.files.values()) {
          loaded += l;
          total += t;
        }
        if (total) this.setStatus({ progress: loaded / total });
        break;
      }
      case 'ready':
        this.setStatus({ state: 'ready', progress: 1, device: m.device });
        this.readyResolve?.();
        this.pump();
        break;
      case 'load-error':
        this.fail(`Couldn't load the natural voice model: ${m.message}`);
        break;
      case 'audio':
      case 'error': {
        const job = this.inflight;
        if (!job || job.id !== m.id) return;
        this.inflight = null;
        if (m.type === 'audio') job.resolve({ url: URL.createObjectURL(new Blob([m.wav], { type: 'audio/wav' })), duration: m.duration });
        else job.reject(new Error(m.message));
        this.pump();
        break;
      }
    }
  }

  private pump() {
    if (this.inflight || this.status.state !== 'ready') return;
    const job = this.queue.shift();
    if (!job) return;
    const id = this.nextId++;
    this.inflight = { ...job, id };
    this.post({ type: 'generate', id, text: job.text, voice: job.voice });
  }

  /** Audio for `text`, generated once and cached. Priority jobs jump the queue. */
  private clip(text: string, voice: string, priority: boolean): Promise<Clip> {
    const key = `${voice}|${text}`;
    const hit = this.cache.get(key);
    if (hit) {
      // Refresh LRU order; promote if still queued.
      this.cache.delete(key);
      this.cache.set(key, hit);
      if (priority) {
        const i = this.queue.findIndex((j) => j.key === key);
        if (i >= 0) {
          const [job] = this.queue.splice(i, 1);
          job.priority = true; // now needed right away: never drop it as stale look-ahead
          this.queue.unshift(job);
        }
      }
      return hit;
    }
    const p = new Promise<Clip>((resolve, reject) => {
      const job: Job = { key, text, voice, priority, resolve, reject };
      if (priority) this.queue.unshift(job);
      else this.queue.push(job);
    });
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, p);
    while (this.cache.size > CACHE_SIZE) {
      const [oldKey, old] = this.cache.entries().next().value!;
      this.cache.delete(oldKey);
      this.queue = this.queue.filter((j) => j.key !== oldKey);
      old.then((c) => URL.revokeObjectURL(c.url)).catch(() => {});
    }
    this.pump();
    return p;
  }

  prefetch(texts: string[], voiceId: string) {
    if (!isKokoroVoice(voiceId) || this.status.state === 'error') return;
    const voice = voiceId.slice(KOKORO_PREFIX.length);
    // Drop queued look-ahead that is no longer coming up (the user jumped elsewhere).
    const wanted = new Set(texts.map((t) => `${voice}|${t}`));
    const dropped = this.queue.filter((j) => !j.priority && !wanted.has(j.key));
    this.queue = this.queue.filter((j) => j.priority || wanted.has(j.key));
    for (const j of dropped) {
      this.cache.delete(j.key);
      j.reject(new Error('cancelled'));
    }
    void this.load().then(() => texts.forEach((t) => void this.clip(t, voice, false).catch(() => {})), () => {});
  }

  speak(text: string, opts: SpeakOptions, cb: EngineCallbacks): Utterance {
    const voice = opts.voiceId.slice(KOKORO_PREFIX.length);
    let stopped = false;
    let paused = false;
    let rate = opts.rate;
    let audio: HTMLAudioElement | null = null;
    let ticker: ReturnType<typeof setInterval> | undefined;
    let started = false;
    const timings = estimateWordTimings(text);
    let lastWord = -1;

    cb.onBuffering?.(true);
    this.load()
      .then(() => this.clip(text, voice, true))
      .then((clip) => {
        if (stopped) return;
        cb.onBuffering?.(false);
        const a = new Audio(clip.url);
        audio = a;
        a.preservesPitch = true;
        a.playbackRate = rate;
        a.onplaying = () => {
          if (stopped || started) return;
          started = true;
          cb.onStart();
        };
        a.onended = () => {
          clearInterval(ticker);
          if (!stopped) cb.onEnd();
        };
        a.onerror = () => {
          clearInterval(ticker);
          if (!stopped) cb.onError('Could not play the generated audio.');
        };
        ticker = setInterval(() => {
          if (stopped || !a.duration) return;
          // Kokoro adds a little silence at both ends.
          const frac = Math.max(0, (a.currentTime - 0.08) / Math.max(0.1, a.duration - 0.25));
          let i = lastWord < 0 ? 0 : lastWord;
          while (i + 1 < timings.length && timings[i + 1][2] <= frac) i++;
          if (i !== lastWord && timings[i]) {
            lastWord = i;
            cb.onWord(timings[i][0], timings[i][1]);
          }
        }, 50);
        if (!paused) a.play().catch((e) => !stopped && cb.onError(`Playback was blocked: ${e instanceof Error ? e.message : e}`));
      })
      .catch((e: Error) => {
        if (stopped) return;
        cb.onBuffering?.(false);
        cb.onError(e.message === 'cancelled' ? 'Generation was cancelled.' : e.message);
      });

    return {
      stop: () => {
        stopped = true;
        clearInterval(ticker);
        if (audio) {
          audio.onended = audio.onerror = audio.onplaying = null;
          audio.pause();
        }
      },
      pause: () => {
        paused = true;
        audio?.pause();
      },
      resume: () => {
        paused = false;
        audio?.play().catch(() => {});
      },
      setRate: (r: number) => {
        rate = r;
        if (audio) audio.playbackRate = r;
      },
    };
  }
}

export const kokoro = new KokoroEngine();

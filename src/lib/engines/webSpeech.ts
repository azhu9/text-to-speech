import type { EngineCallbacks, SpeakOptions, SpeechEngine, Utterance } from './types';

/** Pause after cancel() before speak(); Chrome can drop speech queued immediately. */
const AFTER_CANCEL_MS = 120;
/** If an utterance hasn't started by then, the engine is stuck. */
const START_TIMEOUT_MS = 3000;
const STALL_AFTER_WORD_MS = 4000;
const MAX_RETRIES = 2;
/** Typical speaking speed at rate 1, used to estimate how long text takes. */
const CHARS_PER_SEC = 14;

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

export const webSpeechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

/**
 * The browser's built-in voices (Web Speech API), with workarounds for
 * Chrome: wait after cancel(), retry utterances that never start or stall,
 * and keep online Google voices alive past their ~15 s cutoff.
 */
export class WebSpeechEngine implements SpeechEngine {
  voices: SpeechSynthesisVoice[] = [];
  private cancelledAt = 0;
  /** Kept referenced so Chrome does not garbage-collect it mid-speech and drop its events. */
  live: SpeechSynthesisUtterance | null = null;

  speak(fullText: string, opts: SpeakOptions, cb: EngineCallbacks): Utterance {
    if (!webSpeechSupported()) {
      cb.onError('This browser does not support speech synthesis.');
      return { stop() {} };
    }
    const synth = window.speechSynthesis;
    const voice = this.voices.find((v) => v.voiceURI === opts.voiceId);
    let stopped = false;
    let token = 0;
    let lastWord = 0;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let notifiedStart = false;

    const clearTimers = () => {
      clearTimeout(startTimer);
      clearInterval(watchdog);
    };
    const cancel = () => {
      if (synth.speaking || synth.pending) {
        synth.cancel();
        this.cancelledAt = Date.now();
      }
    };

    const attempt = (from: number, n: number) => {
      clearTimers();
      const t = ++token;
      const text = fullText.slice(from);
      if (!text.trim()) {
        cb.onEnd();
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = engineRate(voice, opts.rate);
      let started = false;
      let sawBoundary = false;
      let lastEvent = 0;

      const retryOrFail = (resumeAt: number, message: string) => {
        if (n < MAX_RETRIES) {
          cancel();
          attempt(resumeAt, n + 1);
        } else {
          clearTimers();
          cancel();
          cb.onError(message);
        }
      };

      u.onstart = () => {
        if (t !== token || stopped) return;
        started = true;
        lastEvent = Date.now();
        if (!notifiedStart) {
          notifiedStart = true;
          cb.onStart();
        }
      };
      u.onboundary = (e) => {
        if (t !== token || stopped || (e.name && e.name !== 'word')) return;
        started = sawBoundary = true;
        lastEvent = Date.now();
        const s = from + e.charIndex;
        lastWord = s;
        cb.onWord(s, e.charLength || /^[^\s]+/.exec(fullText.slice(s))?.[0].length || 0);
      };
      u.onend = () => {
        if (t !== token || stopped) return;
        clearTimers();
        this.live = null;
        cb.onEnd();
      };
      u.onerror = (e) => {
        if (t !== token || stopped || e.error === 'interrupted' || e.error === 'canceled') return;
        retryOrFail(lastWord, `Speech error: ${e.error}. Press play to try again.`);
      };
      this.live = u;

      const expectedMs = (text.length / (CHARS_PER_SEC * u.rate)) * 1000;
      const keepAlive = isGoogleOnlineVoice(voice);
      let lastKeepAlive = Date.now();

      const begin = () => {
        if (t !== token || stopped) return;
        if (synth.paused) synth.resume(); // a paused engine silently queues everything
        synth.speak(u);
        const queuedAt = Date.now();
        watchdog = setInterval(() => {
          if (t !== token || stopped) return;
          const now = Date.now();
          if (!started) {
            // Never started: the engine is jammed. Kick it and retry.
            if (now - queuedAt > START_TIMEOUT_MS) retryOrFail(from, 'The speech engine stopped responding. Press play to try again.');
            return;
          }
          if (keepAlive && now - lastKeepAlive > 10_000 && synth.speaking) {
            synth.pause();
            synth.resume();
            lastKeepAlive = now;
          }
          // Started, but no end event long after it should have finished: stalled.
          const limit = sawBoundary ? STALL_AFTER_WORD_MS + expectedMs * 0.5 : expectedMs * 2 + STALL_AFTER_WORD_MS;
          if (now - lastEvent > limit) {
            if (sawBoundary && n < MAX_RETRIES) retryOrFail(lastWord, '');
            else {
              clearTimers();
              cancel();
              cb.onEnd(); // give up on this sentence and move on
            }
          }
        }, 500);
      };
      const sinceCancel = Date.now() - this.cancelledAt;
      if (sinceCancel < AFTER_CANCEL_MS) startTimer = setTimeout(begin, AFTER_CANCEL_MS - sinceCancel);
      else begin();
    };

    attempt(0, 0);

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        token++;
        clearTimers();
        this.live = null;
        cancel();
      },
    };
  }
}

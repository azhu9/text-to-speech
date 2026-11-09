/** Events an engine reports while saying one piece of text. */
export interface EngineCallbacks {
  onStart(): void;
  /** charIndex/length are relative to the text passed to speak() */
  onWord(charIndex: number, length: number): void;
  onEnd(): void;
  /** The engine gave up on this text (after its own retries). */
  onError(message: string): void;
  /** True while waiting for audio to be generated or downloaded. */
  onBuffering?(waiting: boolean): void;
}

export interface SpeakOptions {
  voiceId: string;
  rate: number;
}

/** A piece of text being spoken. */
export interface Utterance {
  stop(): void;
  /** Engines that can pause and resume in place implement these. */
  pause?(): void;
  resume?(): void;
  /** Engines that can change speed without restarting implement this. */
  setRate?(rate: number): void;
}

export interface SpeechEngine {
  speak(text: string, opts: SpeakOptions, cb: EngineCallbacks): Utterance;
  /** Hint: these texts are coming up next. */
  prefetch?(texts: string[], voiceId: string): void;
}

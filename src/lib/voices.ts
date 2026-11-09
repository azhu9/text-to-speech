import { useEffect, useState } from 'react';

/** macOS/iOS novelty and effect voices: fine as jokes, wrong for reading. */
const NOVELTY = new Set(
  [
    'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Deranged', 'Good News',
    'Hysterical', 'Jester', 'Junior', 'Organ', 'Pipe Organ', 'Princess', 'Ralph', 'Superstar',
    'Trinoids', 'Whisper', 'Wobble', 'Zarvox', 'Fred', 'Kathy',
  ].map((n) => n.toLowerCase()),
);

/** Older, robotic-sounding engines (macOS "Eloquence" voices, eSpeak on Linux). */
const ROBOTIC = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b|espeak/i;

/** Voices known to sound natural. */
const GOOD = /natural|neural|premium|enhanced|siri|^google|^(samantha|alex|daniel|karen|moira|tessa|serena|ava|allison|susan|tom|nicky|aaron|evan|zoe)\b/i;

const baseName = (v: SpeechSynthesisVoice) => v.name.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();

export function isNovelty(v: SpeechSynthesisVoice): boolean {
  return NOVELTY.has(baseName(v));
}

function score(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase();
  let s = 0;
  if (n.includes('natural') || n.includes('neural')) s += 6;
  if (n.includes('premium') || n.includes('enhanced')) s += 5;
  if (GOOD.test(v.name)) s += 3;
  if (v.default) s += 2;
  if (ROBOTIC.test(v.name)) s -= 6;
  return s;
}

/** Usable voices, best-sounding first. Novelty voices are left out. */
export function sortVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return voices
    .filter((v) => !isNovelty(v))
    .sort((a, b) => score(b) - score(a) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
}

export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const synth = window.speechSynthesis;
    const update = () => setVoices(sortVoices(synth.getVoices()));
    update();
    synth.addEventListener('voiceschanged', update);
    // Some browsers fill the list late without firing the event.
    const t = setTimeout(update, 1000);
    return () => {
      synth.removeEventListener('voiceschanged', update);
      clearTimeout(t);
    };
  }, []);
  return voices;
}

const userLang = () => (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US').toLowerCase();

/** Best default: a natural-sounding voice in the user's language and region,
 * else their language, else the system default. Expects sortVoices() output. */
export function defaultVoice(voices: SpeechSynthesisVoice[], lang = userLang()): SpeechSynthesisVoice | undefined {
  const l = lang.toLowerCase();
  const short = l.slice(0, 2);
  const exact = voices.filter((v) => v.lang.toLowerCase().replace('_', '-') === l);
  const same = voices.filter((v) => v.lang.toLowerCase().startsWith(short));
  return exact[0] ?? same[0] ?? voices.find((v) => v.default) ?? voices[0];
}

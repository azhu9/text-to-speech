import { useEffect, useState } from 'react';

/** Voices that tend to sound most natural get listed first. */
function score(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase();
  let s = 0;
  if (n.includes('natural') || n.includes('neural')) s += 4;
  if (n.includes('online')) s += 2;
  if (n.includes('google')) s += 2;
  if (n.includes('premium') || n.includes('enhanced')) s += 2;
  if (v.lang.toLowerCase().startsWith('en')) s += 1;
  return s;
}

export function sortVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return [...voices].sort((a, b) => score(b) - score(a) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
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

/** Best default when the user hasn't picked one: a natural-sounding voice in their language. */
export function defaultVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return voices.find((v) => v.lang.toLowerCase().startsWith(lang)) ?? voices.find((v) => v.default) ?? voices[0];
}

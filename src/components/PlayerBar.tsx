import { useEffect, useMemo } from 'react';
import { clampRate, MAX_RATE, MIN_RATE, type PlayerState, type SpeechPlayer } from '../lib/player';
import { defaultVoice, useVoices } from '../lib/voices';

const PRESETS = [1, 1.5, 2, 2.5, 3];

export function PlayerBar({ player, state }: { player: SpeechPlayer; state: PlayerState }) {
  const voices = useVoices();

  useEffect(() => {
    player.setVoices(voices);
    // Pick a good default if nothing is chosen, or the saved voice is gone
    // (or is a novelty voice, which sortVoices leaves out).
    if (voices.length && !voices.some((v) => v.voiceURI === state.voiceURI)) {
      const v = defaultVoice(voices);
      if (v) player.setVoice(v.voiceURI);
    }
  }, [voices, player, state.voiceURI]);

  const groups = useMemo(() => {
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    const mine = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
    const other = voices.filter((v) => !v.lang.toLowerCase().startsWith(lang));
    return { mine, other };
  }, [voices]);

  const btn =
    'grid h-10 w-10 place-items-center rounded-full text-stone-700 hover:bg-stone-200 disabled:opacity-40 dark:text-stone-200 dark:hover:bg-stone-800';

  return (
    <div className="border-t border-stone-200 bg-white/95 px-4 py-2 backdrop-blur dark:border-stone-800 dark:bg-stone-900/95">
      <input
        type="range"
        aria-label="Position"
        className="mb-1 w-full accent-sky-600"
        min={0}
        max={Math.max(0, state.total - 1)}
        value={state.index}
        onChange={(e) => player.seek(Number(e.target.value))}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1">
          <button className={btn} onClick={() => player.prev()} title="Previous sentence (←)" aria-label="Previous sentence">
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" /></svg>
          </button>
          <button
            className="grid h-12 w-12 place-items-center rounded-full bg-sky-600 text-white shadow hover:bg-sky-700 disabled:opacity-40"
            onClick={() => player.toggle()}
            disabled={!state.total}
            title="Play / pause (space)"
            aria-label={state.playing ? 'Pause' : 'Play'}
          >
            {state.playing ? (
              <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current"><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" className="ml-0.5 h-6 w-6 fill-current"><path d="M8 5v14l11-7z" /></svg>
            )}
          </button>
          <button className={btn} onClick={() => player.next()} title="Next sentence (→)" aria-label="Next sentence">
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current"><path d="M6 18l8.5-6L6 6zm10-12v12h2V6z" /></svg>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button className="h-8 w-8 rounded-full text-lg hover:bg-stone-200 dark:hover:bg-stone-800" onClick={() => player.setRate(state.rate - 0.1)} aria-label="Slower" title="Slower (−)">
            −
          </button>
          <input
            type="range"
            aria-label="Speed"
            className="w-28 accent-sky-600"
            min={MIN_RATE}
            max={MAX_RATE}
            step={0.1}
            value={state.rate}
            onChange={(e) => player.setRate(clampRate(Number(e.target.value)))}
          />
          <button className="h-8 w-8 rounded-full text-lg hover:bg-stone-200 dark:hover:bg-stone-800" onClick={() => player.setRate(state.rate + 0.1)} aria-label="Faster" title="Faster (+)">
            +
          </button>
          <span className="w-12 tabular-nums font-medium">{state.rate.toFixed(1)}×</span>
          <div className="hidden gap-1 md:flex">
            {PRESETS.map((r) => (
              <button
                key={r}
                className={`rounded px-2 py-0.5 text-xs ${state.rate === r ? 'bg-sky-600 text-white' : 'bg-stone-100 hover:bg-stone-200 dark:bg-stone-800 dark:hover:bg-stone-700'}`}
                onClick={() => player.setRate(r)}
              >
                {r}×
              </button>
            ))}
          </div>
        </div>

        <select
          aria-label="Voice"
          className="min-w-0 max-w-full flex-1 rounded-lg border border-stone-300 bg-transparent px-2 py-1.5 text-sm sm:max-w-xs dark:border-stone-700 dark:bg-stone-900"
          value={state.voiceURI ?? ''}
          onChange={(e) => player.setVoice(e.target.value || null)}
        >
          {!voices.length && <option value="">Loading voices…</option>}
          {groups.mine.length > 0 && (
            <optgroup label="Your language">
              {groups.mine.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </optgroup>
          )}
          {groups.other.length > 0 && (
            <optgroup label="Other languages">
              {groups.other.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </optgroup>
          )}
        </select>

        <span className="ml-auto text-xs tabular-nums text-stone-500 dark:text-stone-400">
          {state.total ? `${state.index + 1} / ${state.total}` : ''}
        </span>
      </div>
      {state.error && <p className="mt-1 text-sm text-red-600">{state.error}</p>}
    </div>
  );
}

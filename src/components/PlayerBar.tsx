import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { isKokoroVoice, kokoro, KOKORO_PREFIX, KOKORO_VOICES, DEFAULT_KOKORO_VOICE } from '../lib/engines/kokoro';
import { BASE_WPM, clampRate, isGoogleOnlineVoice, MAX_RATE, MIN_RATE, type PlayerState, type SpeechPlayer } from '../lib/player';
import { useVoices } from '../lib/voices';

const PRESETS = [1, 1.5, 2, 2.5, 3];
const SLEEP_OPTIONS = [5, 10, 15, 30, 45, 60];

function formatDuration(minutes: number): string {
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function PlayerBar({ player, state, wordsLeft }: { player: SpeechPlayer; state: PlayerState; wordsLeft: number }) {
  const voices = useVoices();
  const kStatus = useSyncExternalStore(kokoro.subscribe, kokoro.getStatus);
  const usingKokoro = isKokoroVoice(state.voiceURI);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    player.setVoices(voices);
  }, [voices, player]);

  // First run: natural voice by default. A saved browser voice that no longer exists falls back to it too.
  useEffect(() => {
    if (!state.voiceURI) player.setVoice(DEFAULT_KOKORO_VOICE);
    else if (!usingKokoro && voices.length && !voices.some((v) => v.voiceURI === state.voiceURI)) player.setVoice(DEFAULT_KOKORO_VOICE);
  }, [voices, player, state.voiceURI, usingKokoro]);

  // Start downloading the model as soon as a natural voice is chosen.
  useEffect(() => {
    if (usingKokoro && kStatus.state === 'idle') void kokoro.load().catch(() => {});
  }, [usingKokoro, kStatus.state]);

  // Tick for the sleep countdown.
  useEffect(() => {
    if (state.sleep?.kind !== 'minutes') return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state.sleep]);

  const groups = useMemo(() => {
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return {
      mine: voices.filter((v) => v.lang.toLowerCase().startsWith(lang)),
      other: voices.filter((v) => !v.lang.toLowerCase().startsWith(lang)),
    };
  }, [voices]);

  const wpm = Math.round(BASE_WPM * state.rate);
  const minutesLeft = wordsLeft / wpm;
  const selectedWebVoice = voices.find((v) => v.voiceURI === state.voiceURI);

  const btn =
    'grid h-10 w-10 place-items-center rounded-full text-stone-700 hover:bg-stone-200 disabled:opacity-40 dark:text-stone-200 dark:hover:bg-stone-800';

  let status: { text: string; tone: 'info' | 'warn' | 'error' } | null = null;
  if (usingKokoro && kStatus.state === 'loading')
    status = {
      text: `Downloading natural voices (one-time download)… ${Math.round(kStatus.progress * 100)}%`,
      tone: 'info',
    };
  else if (usingKokoro && kStatus.state === 'error')
    status = { text: `${kStatus.error ?? 'Natural voices failed to load.'} Pick a browser voice, or reload to try again.`, tone: 'error' };
  else if (state.buffering && state.playing) status = { text: 'Preparing audio…', tone: 'info' };
  else if (state.rate > 1.2 && isGoogleOnlineVoice(selectedWebVoice))
    status = { text: 'Google voices get hard to understand when sped up. Natural voices stay clear at any speed.', tone: 'warn' };

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
            className="relative grid h-12 w-12 place-items-center rounded-full bg-sky-600 text-white shadow hover:bg-sky-700 disabled:opacity-40"
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
            {state.playing && state.buffering && (
              <span className="absolute inset-0 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden />
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
          <span className="w-12 font-medium tabular-nums">{state.rate.toFixed(1)}×</span>
          <div className="hidden gap-1 xl:flex">
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
          <optgroup label="Natural voices (Kokoro)">
            {KOKORO_VOICES.map((v) => (
              <option key={v.id} value={KOKORO_PREFIX + v.id}>
                {v.name} ({v.accent} {v.gender})
              </option>
            ))}
          </optgroup>
          {groups.mine.length > 0 && (
            <optgroup label="Browser voices">
              {groups.mine.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </optgroup>
          )}
          {groups.other.length > 0 && (
            <optgroup label="Browser voices: other languages">
              {groups.other.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </optgroup>
          )}
        </select>

        <select
          aria-label="Sleep timer"
          className="rounded-lg border border-stone-300 bg-transparent px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-900"
          value={state.sleep ? (state.sleep.kind === 'chapter' ? 'chapter' : String(state.sleep.minutes)) : ''}
          onChange={(e) => {
            const v = e.target.value;
            player.setSleep(!v ? null : v === 'chapter' ? { kind: 'chapter' } : { kind: 'minutes', minutes: Number(v) });
          }}
          title="Sleep timer"
        >
          <option value="">Sleep timer: off</option>
          {SLEEP_OPTIONS.map((m) => (
            <option key={m} value={m}>
              Stop in {m} min
            </option>
          ))}
          <option value="chapter">Stop at end of section</option>
        </select>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 text-xs text-stone-500 tabular-nums dark:text-stone-400">
        <span title="Estimated listening time left at this speed">{state.total ? `≈ ${formatDuration(minutesLeft)} left` : ''}</span>
        <span title="Approximate words per minute">~{wpm} wpm</span>
        {state.sleep?.kind === 'minutes' && <span>Sleep in {formatClock(state.sleep.endsAt - now)}</span>}
        {state.sleep?.kind === 'chapter' && <span>Stopping at end of section</span>}
        {status && (
          <span className={status.tone === 'error' ? 'text-red-600' : status.tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-sky-700 dark:text-sky-400'}>
            {status.text}
          </span>
        )}
        <span className="ml-auto">{state.total ? `${state.index + 1} / ${state.total}` : ''}</span>
      </div>
      {state.error && <p className="mt-1 text-sm text-red-600">{state.error}</p>}
    </div>
  );
}

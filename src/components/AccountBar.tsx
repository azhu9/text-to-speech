import { useEffect, useState } from 'react';
import { cloudConfigured, signInWithGoogle, signOut, useAuth, useSyncStatus } from '../lib/cloud';
import { sync } from '../lib/sync';

function ago(t: number, now: number) {
  const s = Math.round((now - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** Sign-in button, or the signed-in account with its sync status. */
export function AccountBar() {
  const auth = useAuth();
  const status = useSyncStatus();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  if (!cloudConfigured) {
    return (
      <span className="text-xs text-stone-400" title="Add your Supabase project to .env.local to turn on Google sign-in (see docs/SIGN_IN_SETUP.md)">
        Sync not set up
      </span>
    );
  }
  if (!auth.ready) return <span className="text-sm text-stone-400">…</span>;

  if (!auth.session) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          className="flex items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800"
          onClick={() => void signInWithGoogle()}
        >
          <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
          </svg>
          Sign in with Google
        </button>
        <span className="text-xs text-stone-400">Sync your library and notes across computers</span>
        {auth.error && <span className="text-xs text-red-600">{auth.error}</span>}
      </div>
    );
  }

  const user = auth.session.user;
  const name = (user.user_metadata?.full_name as string | undefined) ?? user.email ?? 'Signed in';
  const avatar = user.user_metadata?.avatar_url as string | undefined;
  const label =
    status.state === 'syncing'
      ? 'Syncing…'
      : status.state === 'offline'
        ? 'Offline — will sync when back online'
        : status.state === 'error'
          ? `Sync problem: ${status.error}`
          : status.lastSynced
            ? `Synced ${ago(status.lastSynced, now)}`
            : 'Connecting…';
  const tone = status.state === 'error' ? 'text-red-600' : status.state === 'offline' ? 'text-amber-700 dark:text-amber-400' : 'text-stone-500 dark:text-stone-400';

  return (
    <div className="flex items-center gap-3">
      {avatar ? (
        <img src={avatar} alt="" className="h-8 w-8 rounded-full" referrerPolicy="no-referrer" />
      ) : (
        <span className="grid h-8 w-8 place-items-center rounded-full bg-sky-600 text-sm font-semibold text-white">{name.slice(0, 1).toUpperCase()}</span>
      )}
      <div className="text-right text-sm leading-tight">
        <div className="font-medium">{name}</div>
        <div className={`text-xs ${tone}`}>
          {label}
          {status.state === 'error' && (
            <button className="ml-1 underline" onClick={() => void sync.syncNow()}>
              Retry
            </button>
          )}
        </div>
        {status.skippedFiles?.length ? (
          <div className="text-xs text-amber-700 dark:text-amber-400">{status.skippedFiles.length} large PDF(s) kept on this computer only</div>
        ) : null}
      </div>
      <button className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-stone-100" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}

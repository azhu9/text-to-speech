import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';
import { installChangeTracking, sync, type Remote, type RemoteRow } from './sync';

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when this build has a Supabase project configured (.env.local). */
export const cloudConfigured = !!(URL_ && KEY);

export const supabase: SupabaseClient | null = cloudConfigured
  ? createClient(URL_!, KEY!, {
      auth: {
        // PKCE returns ?code= in the query string, which doesn't clash with the
        // app's #/doc/... hash routes (the implicit flow would).
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

const BUCKET = 'files';

/** Remote implementation backed by the `records` table and the `files` bucket (see supabase/schema.sql). */
export class SupabaseRemote implements Remote {
  constructor(
    private client: SupabaseClient,
    private userId: string,
  ) {}

  async upsert(rows: RemoteRow[]) {
    const { error } = await this.client
      .from('records')
      .upsert(rows.map((r) => ({ user_id: this.userId, kind: r.kind, key: r.key, data: r.data, deleted: r.deleted })), { onConflict: 'user_id,kind,key' });
    if (error) throw new Error(`Upload failed: ${error.message}`);
  }

  async pull(after: number, limit: number) {
    const { data, error } = await this.client
      .from('records')
      .select('kind,key,data,deleted,seq')
      .gt('seq', after)
      .order('seq', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`Download failed: ${error.message}`);
    return (data ?? []) as RemoteRow[];
  }

  private path(docId: string) {
    return `${this.userId}/${docId}.pdf`;
  }

  async uploadFile(docId: string, blob: Blob) {
    const { error } = await this.client.storage.from(BUCKET).upload(this.path(docId), blob, { upsert: true, contentType: blob.type || 'application/pdf' });
    if (error) throw new Error(error.message);
  }

  async downloadFile(docId: string) {
    const { data, error } = await this.client.storage.from(BUCKET).download(this.path(docId));
    if (error) return null;
    return data;
  }

  async deleteFile(docId: string) {
    const { error } = await this.client.storage.from(BUCKET).remove([this.path(docId)]);
    if (error) throw new Error(error.message);
  }
}

// --- auth state -------------------------------------------------------------

export interface AuthState {
  ready: boolean;
  session: Session | null;
  error?: string;
}

let auth: AuthState = { ready: !cloudConfigured, session: null };
const listeners = new Set<() => void>();
const setAuth = (a: Partial<AuthState>) => {
  auth = { ...auth, ...a };
  listeners.forEach((l) => l());
};

let started = false;
let syncingFor: string | null = null;

function onSession(session: Session | null) {
  setAuth({ ready: true, session });
  const uid = session?.user.id ?? null;
  if (uid === syncingFor) return;
  syncingFor = uid;
  if (uid && supabase) void sync.start(new SupabaseRemote(supabase, uid), uid);
  else sync.stop();
}

/** Call once at startup: tracks local changes and restores a signed-in session. */
export function initCloud() {
  if (started) return;
  started = true;
  installChangeTracking();
  if (!supabase) return;
  supabase.auth.getSession().then(({ data, error }) => {
    if (error) setAuth({ error: error.message });
    onSession(data.session);
  });
  supabase.auth.onAuthStateChange((_event, session) => onSession(session));
}

export async function signInWithGoogle() {
  if (!supabase) return;
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) setAuth({ error: error.message });
}

export async function signOut() {
  if (!supabase) return;
  await sync.syncNow().catch(() => {});
  await supabase.auth.signOut();
}

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => auth,
  );
}

export function useSyncStatus() {
  return useSyncExternalStore(sync.subscribe, sync.getStatus);
}

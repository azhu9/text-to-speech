/**
 * Settings that live in localStorage but should follow the user's account.
 * Save functions call markSettingChanged(); the sync engine uploads them.
 */
export const SYNCED_SETTINGS = [
  'read-aloud:pronunciations',
  'read-aloud:skip-patterns',
  'read-aloud:skip',
  'read-aloud:queue',
  'read-aloud:player',
] as const;

const DIRTY_KEY = 'read-aloud:settings-dirty';
export const SETTINGS_EVENT = 'read-aloud:settings-changed';

export function dirtySettings(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DIRTY_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function setDirtySettings(keys: string[]) {
  try {
    localStorage.setItem(DIRTY_KEY, JSON.stringify([...new Set(keys)]));
  } catch {
    /* ignore */
  }
}

export function markSettingChanged(key: string) {
  setDirtySettings([...dirtySettings(), key]);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: { key, local: true } }));
}

/** Apply a setting that came from the cloud (does not mark it changed). */
export function applyRemoteSetting(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: { key, local: false } }));
}

export function readSetting(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Save a synced setting; it is only marked for upload if it actually changed. */
export function saveSetting(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  try {
    if (localStorage.getItem(key) === raw) return;
    localStorage.setItem(key, raw);
  } catch {
    return;
  }
  markSettingChanged(key);
}

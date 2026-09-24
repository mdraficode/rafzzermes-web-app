/**
 * Token + preference storage.
 *
 * Android used `flutter_secure_storage` (EncryptedSharedPreferences / Keychain).
 * A browser has no equivalent primitive available to page JavaScript, so the
 * honest mapping is `localStorage`:
 *
 *   - it persists across tab closes and browser restarts, matching
 *     `RelayProvider._loadToken()` restoring the session on app launch;
 *   - it is NOT encrypted, and page scripts (or any XSS) can read it.
 *
 * Credentials themselves are never stored — only the bearer token.
 */

export const StorageKeys = {
  token: 'rafzzermes.relay_token',
  theme: 'rafzzermes.theme',
} as const;

interface Backend {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** In-memory fallback for environments where storage is blocked. */
function memoryBackend(): Backend {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}

/**
 * Safari private mode, third-party iframes with storage partitioning disabled,
 * and some enterprise policies make `localStorage` throw on access — even
 * reading `window.localStorage` can throw. Probe once, then commit.
 */
function detectBackend(): { backend: Backend; persistent: boolean } {
  try {
    const ls = globalThis.localStorage;
    const probe = '__rafzzermes_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return {
      persistent: true,
      backend: {
        get: (key) => ls.getItem(key),
        set: (key, value) => void ls.setItem(key, value),
        remove: (key) => void ls.removeItem(key),
      },
    };
  } catch {
    return { backend: memoryBackend(), persistent: false };
  }
}

const { backend, persistent } = detectBackend();

/**
 * True when values survive a reload (i.e. real localStorage is in use). False
 * means the session is in-memory only, which the login screen surfaces so the
 * user is not surprised when a refresh logs them out.
 */
export const persistentStorageAvailable = persistent;

export function readString(key: string): string | null {
  try {
    return backend.get(key);
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string): void {
  try {
    backend.set(key, value);
  } catch {
    /* quota exceeded or storage revoked mid-session — ignore */
  }
}

export function removeKey(key: string): void {
  try {
    backend.remove(key);
  } catch {
    /* ignore */
  }
}

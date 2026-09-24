/**
 * Web counterpart of `lib/core/config.dart` (AppConfig).
 *
 * In the Android build the relay endpoint was chosen at compile time:
 *
 *   flutter build apk --dart-define=RELAY_BASE_URL=https://relay.example.com
 *
 * A browser app has no `--dart-define`, so this module resolves in the same
 * spirit but with an extra level so a deployed bundle can be re-pointed
 * without a rebuild:
 *
 *   1. an override saved in this browser (Settings → Relay endpoint)
 *   2. VITE_RELAY_BASE_URL, baked in at `npm run build` time
 *   3. the legacy LAN default from config.dart
 */

export const RELAY_URL_STORAGE_KEY = 'rafzzermes.relay_url';

/** Level 2: baked in at build time (the `--dart-define` equivalent). */
export const COMPILE_TIME_RELAY_BASE_URL: string = (
  import.meta.env.VITE_RELAY_BASE_URL ?? ''
).trim();

/**
 * Level 3: the default that shipped in `config.dart`.
 *
 * It is kept so the app still works against a relay on the LAN, but it is
 * plain HTTP — see `transportProblem()` below. A page served over HTTPS
 * cannot call it (mixed content), so set VITE_RELAY_BASE_URL for production.
 */
export const LEGACY_DEFAULT_RELAY_BASE_URL = 'http://79.76.61.69:9602';

export const DEFAULT_RELAY_BASE_URL =
  COMPILE_TIME_RELAY_BASE_URL || LEGACY_DEFAULT_RELAY_BASE_URL;

/**
 * Normalises user-entered endpoints: trims, defaults the scheme to https, and
 * drops any trailing slash so `base + '/auth/login'` never double-slashes.
 * Returns null when the value cannot be a host at all.
 */
export function normalizeRelayBaseUrl(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  url.search = '';
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** Reads the browser-local override, if one was saved and is still valid. */
export function readStoredRelayBaseUrl(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(RELAY_URL_STORAGE_KEY);
    return raw ? normalizeRelayBaseUrl(raw) : null;
  } catch {
    return null;
  }
}

export function storeRelayBaseUrl(baseUrl: string | null): void {
  try {
    if (baseUrl === null) globalThis.localStorage?.removeItem(RELAY_URL_STORAGE_KEY);
    else globalThis.localStorage?.setItem(RELAY_URL_STORAGE_KEY, baseUrl);
  } catch {
    /* storage blocked (private mode / sandboxed iframe) — runtime value still applies */
  }
}

export class AppConfig {
  /** Resolved relay endpoint: browser override → build-time → legacy default. */
  static get relayBaseUrl(): string {
    return readStoredRelayBaseUrl() ?? DEFAULT_RELAY_BASE_URL;
  }

  /** True when the relay URL came from the build or an override, not the fallback. */
  static get hasConfiguredRelay(): boolean {
    return (
      readStoredRelayBaseUrl() !== null || COMPILE_TIME_RELAY_BASE_URL.length > 0
    );
  }
}

/** Hostnames browsers treat as trustworthy even over plain HTTP. */
function isPotentiallyTrustworthyHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  );
}

/**
 * Detects configurations the *browser* will refuse before any request is made,
 * so the UI can explain the failure instead of showing a raw network error.
 *
 * This is a web-only concern with no Android equivalent: `network_security_config.xml`
 * opted the APK back into cleartext, but no browser offers that escape hatch.
 */
export function transportProblem(baseUrl: string): string | null {
  if (typeof window === 'undefined') return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'That relay endpoint is not a valid URL.';
  }

  const pageIsHttps = window.location.protocol === 'https:';
  const relayIsHttp = url.protocol === 'http:';

  if (pageIsHttps && relayIsHttp && !isPotentiallyTrustworthyHost(url.hostname)) {
    return (
      `This page is served over HTTPS, so the browser will block requests to the ` +
      `plain-HTTP relay ${baseUrl} as mixed content. Point the relay at an HTTPS ` +
      `endpoint (Settings → Relay endpoint) — for example a Cloudflare Tunnel, ` +
      `Caddy with a Let's Encrypt certificate, or any TLS terminator in front of it.`
    );
  }

  if (relayIsHttp && !isPotentiallyTrustworthyHost(url.hostname)) {
    return (
      `The relay ${baseUrl} is plain HTTP, so your credentials travel unencrypted. ` +
      `Fine on a trusted LAN; put it behind HTTPS before using it over the internet.`
    );
  }

  return null;
}

/** Short, human-readable label for the current relay (used in the app bar). */
export function relayDisplayHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** True when the page itself is being served insecurely. */
export function pageIsInsecure(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.protocol === 'http:' &&
    !isPotentiallyTrustworthyHost(window.location.hostname)
  );
}

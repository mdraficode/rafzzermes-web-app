/**
 * Turns the opaque failures a browser produces into something a user can act on.
 *
 * The Android client never needed this: a native app either reaches the relay or
 * raises a socket exception. In a browser, `fetch()` rejects with a bare
 * `TypeError` for a whole family of causes that are indistinguishable from page
 * JavaScript — DNS failure, the relay being down, a missing CORS header, a TLS
 * problem, or the browser refusing a plain-HTTP request from an HTTPS page.
 */
export function describeTransportFailure(error: unknown): string {
  if (error instanceof TypeError) {
    return (
      'Could not reach the relay. It may be offline, blocking this origin (CORS), ' +
      'or the browser blocked a plain-HTTP relay from this HTTPS page — ' +
      'see Settings → Relay endpoint.'
    );
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

# Rafzzermes Web App

The browser edition of the **Rafzzermes App** — same product, same protocol, same
screens, running in any modern browser instead of an Android APK.

It talks to the identical relay the Flutter client did:

| Transport | Endpoint | Purpose |
|---|---|---|
| WebSocket | `GET {relay}/sync?token=…` | Server → client events |
| HTTP | `POST {relay}/auth/login` | Sign in, returns `{token}` |
| HTTP + SSE | `POST {relay}/v1/chat` | Streaming chat completion |
| HTTP | `POST {relay}/v1/models` | Model list |
| WebSocket send | `{"type":"sync","lastSeq":N}` | Catch-up after reconnect |

## Read this first: the relay must be HTTPS

The Android app shipped with `http://79.76.61.69:9602` as its default endpoint and
carried `network_security_config.xml` to let Android permit cleartext traffic.

**A browser has no equivalent escape hatch.** Today's browsers block a page served over
HTTPS from calling an HTTP backend — "mixed content" — and `https://…github.io` is HTTPS.
So on the deployed site, login against a plain-HTTP relay will fail before the request
leaves the browser.

You need a TLS endpoint in front of the relay. Any one of these works:

**Cloudflare Tunnel** (free, no port forwarding, terminates TLS):

```bash
cloudflared tunnel login
cloudflared tunnel create rafzzermes
cloudflared tunnel route dns rafzzermes relay.yourdomain.com
cloudflared tunnel run --url http://localhost:9602 rafzzermes
```

**Caddy on the relay box** (free Let's Encrypt certificate, auto-renewing):

```
relay.yourdomain.com {
    reverse_proxy 127.0.0.1:9602
}
```

Caddy proxies WebSocket upgrades and streaming responses with no extra configuration.

**Cloudflare Worker** (a thin HTTPS/CORS shim if you would rather not touch the server):

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, 'http://79.76.61.69:9602');
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.headers.get('Upgrade') === 'websocket') {
      return fetch(new Request(target, request)); // requires a zone with WebSockets on
    }
    const response = await fetch(new Request(target, request));
    return new Response(response.body, {
      status: response.status,
      headers: { ...Object.fromEntries(response.headers), ...cors },
    });
  },
};
```

Once you have an HTTPS URL, point the app at it in **three possible ways**, highest
precedence first:

1. **In the app** — Settings ⚙ → *Relay endpoint* → Save. Stored in that browser only.
2. **In the URL** — `https://mdraficode.github.io/rafzzermes-web-app/?relay=https://relay.yourdomain.com`
   remembers it for that browser, so you can hand out one link that just works.
   `?relay=default` clears it.
3. **At build time** — `VITE_RELAY_BASE_URL=https://relay.yourdomain.com npm run build`
   (the web equivalent of the Android `--dart-define=RELAY_BASE_URL`).

If none is set, the app falls back to the legacy `http://79.76.61.69:9602` and shows a
warning banner explaining why the browser will refuse it.

There is a second reason an HTTPS shim may be required: the relay must send
`Access-Control-Allow-Origin` for this origin. A native Android app is not subject to
CORS; a web page is. If login fails with a network error while the relay is up, CORS is
the usual cause.

## Run it

```bash
cd web
npm install
npm run dev          # http://localhost:5173/rafzzermes-web-app/
```

While the dev server is on `http://localhost`, browsers treat `localhost` as a trusted
origin even over plain HTTP, so you can talk to a local HTTP relay from it.

```bash
npm run build        # typecheck + production bundle into web/dist
npm run preview      # serve the built bundle
npm test             # 75 tests
npm run typecheck
```

## How it maps onto the Flutter project

The web app is a direct port, not a rewrite — every Dart file has a counterpart with the
same responsibilities:

| Android (Flutter) | Web (this project) |
|---|---|
| `lib/main.dart` | `src/main.tsx`, `src/App.tsx` |
| `lib/core/config.dart` (`AppConfig`) | `src/core/config.ts` |
| `lib/core/config.dart` (`ThemeProvider`) | `src/ui/theme.ts` |
| `lib/core/relay_provider.dart` | `src/core/relayProvider.ts` |
| `lib/core/client/relay_client.dart` | `src/core/client/relayClient.ts` |
| `lib/features/auth/login_screen.dart` | `src/features/auth/LoginScreen.tsx` |
| `lib/features/chat/chat_screen.dart` (`ChatMessage`, `_MessageBubble`, `_StatusBubble`, `_Composer`) | `src/features/chat/chatController.ts`, `src/features/chat/ChatScreen.tsx` |
| `flutter_secure_storage` | `src/core/storage.ts` (localStorage, with an in-memory fallback) |
| `provider` (`ChangeNotifier`, `context.watch`) | `src/core/notifier.ts`, `src/core/useNotifier.ts` (`useSyncExternalStore`) |

Preserved behaviour, deliberately:

- the same login copy — *"Enter Hermes Workspace credentials"*, `Username`, `Password`, `Log In`
- the same validation — *"Enter username and password"*, trimmed before use
- the same session model — a stored token restores the session on load, and the home
  screen switches on `isLoggedIn` exactly as `main.dart` did
- the same chat semantics — optimistic user bubble, assistant bubble filled by SSE deltas,
  `workflow_update` → a transient `⏳ … (assigned in progress…)` status bubble that is
  swept away when a real message lands, failures rendered as `Error: …`
- the same bubble geometry — user right-aligned with a 4px bottom-right corner,
  assistant left-aligned with a 4px bottom-left corner
- the same OpenAI-style SSE parsing — `choices[0].delta.content`, terminated by `[DONE]`
- the same WebSocket contract — `/sync` with the token in the query string (browsers
  cannot set headers on a WebSocket, so this remains the only option), and
  `{"type":"sync","lastSeq":N}` sent after every successful handshake

### Defects from `ANALYSIS.md` fixed here, not carried over

These were open WebSocket/UI issues in the Android source. Each has a regression test.

| Defect | Fix |
|---|---|
| `RelayProvider.connect()` set `_connected = true` *before* the handshake, so the UI claimed "connected" while offline | state advances only on a real socket `open` event |
| every `connect()` built a new socket without closing the previous one | `RelayClient.connect()` closes the old socket first, and `isActive` makes a redundant `connect()` a no-op |
| login created **two** sockets (the screen's own client *and* the provider's) | the login screen owns no client; `RelayProvider.login()` is the single entry point |
| a dropped socket stayed dead, and `sync`/`lastSeq` catch-up was never exercised after login | exponential-backoff reconnect (1s→30s) plus an immediate retry on the browser `online` event |
| `utf8.decode(chunk)` threw on a multi-byte character split across chunk boundaries | `TextDecoder({stream: true})` |
| `login()` assumed a JSON body and threw a raw `FormatException` otherwise | non-JSON responses become a clear `RelayHttpError` |
| `listModels()` sent no body with `Content-Type: application/json` | sends `{}` |
| `postChatStream()` ignored the HTTP status, streaming error pages into the transcript | non-2xx throws; in-stream `{"error": …}` frames surface as errors |
| a stream that produced nothing left a permanently blank bubble | reports *"the relay closed the stream without sending a reply"* |
| `ThemeProvider` existed but nothing could call `toggle()` — the app was stuck light | theme toggle in the app bar, persisted, defaults to the OS preference |

## Tests

`npm test` — 75 tests, no network and no browser required.

- `tests/relayClient.test.ts` — URL normalisation, `ws`/`wss` derivation, SSE framing
  (`\n`, `\r\n`, bare `\r`, CRLF split across chunks, keep-alive comments, unterminated
  final line), payload extraction, login error paths, streaming, abort, and the full
  WebSocket lifecycle including stale-socket frames.
- `tests/relayProvider.test.ts` — session restore, single-socket login, handshake-gated
  connection state, `lastSeq` catch-up, logout, and dispose.
- `tests/chatController.test.ts` — send/stream/error paths, status-bubble de-duplication,
  remote replay de-duplication, cancellation.
- `tests/app.ui.test.tsx` — the real `<App>` rendered in jsdom: login screen copy,
  validation, login → chat transition, streaming a reply through the composer, a
  `workflow_update` status bubble, settings sheet, logout, session restore, theme toggle.

## Deploy

The published site is **https://mdraficode.github.io/rafzzermes-web-app/**, served by
GitHub Pages from the `gh-pages` branch (Pages source: *deploy from a branch*).

`web/dist` is copied to the branch root by `.github/workflows/deploy-web.yml` whenever
`web/**` changes on `gh-pages`, so the live site always matches the source. To do it by
hand:

```bash
cd web && VITE_BASE=/rafzzermes-web-app/ npm run build
# then copy dist/* to the root of the gh-pages branch and push
```

`.nojekyll` must exist at the branch root so Pages does not run the output through Jekyll.

## Notes and limits

- **The token lives in `localStorage`.** That is the honest browser analogue of
  `flutter_secure_storage` — it persists across restarts but is *not* encrypted, and any
  script on the origin can read it. Credentials themselves are never stored.
- **The token travels in the `/sync` query string**, as it did on Android. Browser
  WebSockets cannot set an `Authorization` header, so this is the only option without
  changing the relay's contract. Query strings are routinely logged by proxies.
- **Transcripts are in memory only.** A page reload starts a fresh conversation, matching
  the Android widget's behaviour. Messages that arrive while the socket is down are
  replayed by the relay's `sync`/`lastSeq` mechanism and absorbed into the transcript.
- **`message_new` payload handling is defensive.** `ANALYSIS.md` notes the Dart client
  ignored the frame's contents, and the relay's exact schema is not in this repo. The
  controller reads `content`/`text`/`message` and de-duplicates by `id`, or against the
  newest message, so catch-up replay works without risk of showing a message twice.
- **Not verified against the live relay.** The sandbox this was built in cannot reach
  `79.76.61.69:9602`, and has no browser binary. Everything above is verified by the test
  suite and the production build; the wire protocol is verified against the Dart client's
  code, not against a running relay.

/**
 * RelayClient — browser port of `lib/core/client/relay_client.dart`.
 *
 * Wire contract is unchanged from the Android client:
 *   - WebSocket  GET  {base}/sync?token=…      (server → client events)
 *   - HTTP  POST {base}/auth/login             {username, password, workspaceUrl}
 *   - HTTP  POST {base}/v1/chat                OpenAI-style SSE stream
 *   - HTTP  POST {base}/v1/models              {data: [...]}
 *   - WebSocket send  {"type":"sync","lastSeq":N}
 */

/** Minimal structural type for a browser WebSocket (injectable for tests). */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `(eventName, payload)` — same tuple shape as the Dart `(String, Map)`. */
export type RelayEvent = [string, Record<string, unknown>];
export type RelayEventListener = (event: RelayEvent) => void;

export class RelayHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'RelayHttpError';
    this.status = status;
    this.body = body;
  }
}

/* ------------------------------------------------------------------ *
 * SSE parsing (pure functions — unit-tested without a network)
 * ------------------------------------------------------------------ */

/**
 * Splits an SSE byte stream into `data:` payloads.
 *
 * Handles the framing the Android client assumed (`\n`-terminated lines) plus
 * `\r\n` / bare-`\r`, multi-chunk UTF-8 boundaries, comment lines (`:` keep-alives)
 * and the `event:` / `id:` / `retry:` fields, which are ignored.
 */
export class SseLineParser {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;

    // A lone trailing \r might be the first half of a CRLF still in flight, so
    // hold it back rather than splitting the line early.
    const holdBack = this.buffer.endsWith('\r');
    const searchable = holdBack ? this.buffer.slice(0, -1) : this.buffer;

    // \r\n must be matched before the bare \r alternative.
    const separator = /\r\n|\n|\r/g;
    const lines: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = separator.exec(searchable)) !== null) {
      lines.push(searchable.slice(lastIndex, match.index));
      lastIndex = match.index + match[0].length;
    }
    this.buffer = searchable.slice(lastIndex) + (holdBack ? '\r' : '');

    const payloads: string[] = [];
    for (const line of lines) {
      const payload = interpretSseLine(line);
      if (payload !== null) payloads.push(payload);
    }
    return payloads;
  }

  /** Emits a trailing payload for streams that end without a newline. */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = '';
    if (!rest) return [];
    const payload = interpretSseLine(rest);
    return payload === null ? [] : [payload];
  }
}

function interpretSseLine(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line || line.startsWith(':')) return null;
  if (!line.startsWith('data:')) return null;
  return line.slice('data:'.length).trim();
}

export type DeltaResult =
  | { kind: 'content'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'skip' };

/**
 * Extracts a token delta from one SSE payload.
 *
 * Primary shape is the OpenAI chat-completion chunk the Dart client parsed:
 *   {"choices":[{"delta":{"content":"Hi"}}]}   → content
 *   [DONE]                                      → end of stream
 *
 * Also surfaces relay-side `{"error": …}` frames instead of silently dropping
 * them, and tolerates flatter shapes (`delta` / `content` / `text` / `token` as
 * plain strings) that simpler relays emit. Anything unrecognised is skipped,
 * exactly as before.
 */
export function extractDelta(payload: string): DeltaResult {
  if (!payload) return { kind: 'skip' };
  if (payload === '[DONE]') return { kind: 'done' };

  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    // The Dart client skipped non-JSON lines; keep that, but leave a trace.
    console.warn('[relay] skipped non-JSON SSE payload', payload.slice(0, 200));
    return { kind: 'skip' };
  }

  if (typeof data !== 'object' || data === null) return { kind: 'skip' };
  const obj = data as Record<string, unknown>;

  if (typeof obj.error === 'string' && obj.error) {
    return { kind: 'error', message: obj.error };
  }
  if (obj.error && typeof obj.error === 'object') {
    const message = (obj.error as Record<string, unknown>).message;
    if (typeof message === 'string' && message) return { kind: 'error', message };
  }

  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (first && typeof first === 'object') {
      const record = first as Record<string, unknown>;
      const delta = record.delta;
      let content: unknown;
      if (typeof delta === 'string') content = delta;
      else if (delta && typeof delta === 'object') {
        content = (delta as Record<string, unknown>).content;
      }
      if (content === undefined) content = record.text ?? record.content;
      if (typeof content === 'string' && content.length > 0) {
        return { kind: 'content', text: content };
      }
    }
    return { kind: 'skip' };
  }

  for (const key of ['delta', 'content', 'text', 'token'] as const) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) {
      return { kind: 'content', text: value };
    }
  }

  return { kind: 'skip' };
}

/* ------------------------------------------------------------------ *
 * URL helpers
 * ------------------------------------------------------------------ */

/** `http→ws`, `https→wss`, then appends `/sync` and the token query param. */
export function webSocketUrlFor(baseUrl: string, token?: string | null): string {
  const withPath = `${baseUrl}/sync`;
  const wsUrl = withPath
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:')
    .replace(/^ws:/i, 'ws:');
  const url = new URL(wsUrl);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

export interface RelayClientOptions {
  baseUrl: string;
  webSocketFactory?: WebSocketFactory;
  fetchImpl?: FetchLike;
}

export interface LoginArgs {
  username: string;
  password: string;
  workspaceUrl?: string | null;
}

export interface ChatStreamOptions {
  token?: string | null;
  signal?: AbortSignal;
}

export class RelayClient {
  readonly baseUrl: string;

  private ws: WebSocketLike | null = null;
  private readonly listeners = new Set<RelayEventListener>();
  private readonly webSocketFactory: WebSocketFactory;
  private readonly fetchImpl: FetchLike;
  private intentionalClose = false;

  /** Fires once the socket handshake completes (not before). */
  onOpen: ((event: unknown) => void) | null = null;
  /** Fires when the socket closes, for any reason. */
  onClose: ((event: unknown) => void) | null = null;
  onError: ((event: unknown) => void) | null = null;

  constructor(options: RelayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1; /* OPEN */
  }

  /**
   * True while a socket is open *or still handshaking*. `connect()` callers use
   * this to avoid tearing down a handshake that is already in flight.
   */
  get isActive(): boolean {
    return this.ws !== null && (this.ws.readyState === 0 || this.ws.readyState === 1);
  }

  /** Subscribes to decoded relay events; returns the unsubscribe function. */
  onEvent(listener: RelayEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Opens `/sync`.
   *
   * The bearer token goes in the query string because the browser WebSocket
   * constructor cannot set headers — same constraint the Dart client worked
   * under. Any existing socket is closed first, so repeated connect() calls do
   * not leak sockets.
   */
  connect({ token }: { token?: string | null } = {}): void {
    this.disconnect();

    const url = webSocketUrlFor(this.baseUrl, token);
    let socket: WebSocketLike;
    try {
      socket = this.webSocketFactory(url);
    } catch (error) {
      console.error('[relay] WebSocket construction failed', error);
      this.onError?.(error);
      return;
    }

    this.ws = socket;
    this.intentionalClose = false;

    socket.onopen = (event) => {
      if (this.ws !== socket) return;
      this.onOpen?.(event);
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.warn('[relay] dropped non-JSON WebSocket frame', raw.slice(0, 200));
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      const data = parsed as Record<string, unknown>;
      const name = typeof data.type === 'string' ? data.type : 'unknown';
      this.emit([name, data]);
    };

    socket.onerror = (event) => {
      if (this.ws !== socket) return;
      this.onError?.(event);
    };

    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      const wasIntentional = this.intentionalClose;
      this.intentionalClose = false;
      if (!wasIntentional) this.onClose?.(event);
    };
  }

  disconnect(): void {
    const socket = this.ws;
    if (!socket) return;
    this.ws = null;
    this.intentionalClose = true;
    // Detach first: handlers check `this.ws !== socket`, but a browser may fire
    // close asynchronously after the socket is replaced.
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(1000, 'client disconnect');
    } catch {
      /* already closing */
    }
  }

  /** Sends the catch-up frame the relay expects after a reconnect. */
  sendSync({ lastSeq }: { lastSeq?: number } = {}): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ type: 'sync', lastSeq: lastSeq ?? 0 }));
  }

  private emit(event: RelayEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error('[relay] listener threw', error);
      }
    }
  }

  /** POST /auth/login. Returns the parsed body; throws on non-2xx. */
  async login({
    username,
    password,
    workspaceUrl,
  }: LoginArgs): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, workspaceUrl: workspaceUrl ?? null }),
    });

    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new RelayHttpError(
        `login failed: the relay returned a non-JSON response (HTTP ${response.status})`,
        response.status,
        text,
      );
    }

    if (response.ok) return body;

    const detail = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new RelayHttpError(`login failed: ${detail}`, response.status, text);
  }

  /**
   * POST /v1/chat with SSE streaming. Yields content deltas as they arrive —
   * the browser equivalent of the Dart `Stream<String> postChatStream(...)`.
   */
  async *postChatStream(
    payload: Record<string, unknown>,
    { token, signal }: ChatStreamOptions = {},
  ): AsyncGenerator<string, void, undefined> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new RelayHttpError(
        `chat failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`,
        response.status,
        detail,
      );
    }

    if (!response.body) {
      // No streaming support (very old browser, or a buffering proxy).
      const text = await response.text();
      const parser = new SseLineParser();
      for (const chunk of [...parser.push(text), ...parser.flush()]) {
        const result = extractDelta(chunk);
        if (result.kind === 'content') yield result.text;
        else if (result.kind === 'error') throw new Error(result.message);
        else if (result.kind === 'done') return;
      }
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const parser = new SseLineParser();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // {stream: true} keeps a split multi-byte codepoint in the decoder
        // instead of producing U+FFFD — the Dart version decoded each chunk
        // independently, which corrupted any non-ASCII character split across
        // a chunk boundary.
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
          const result = extractDelta(payload);
          if (result.kind === 'content') yield result.text;
          else if (result.kind === 'error') throw new Error(result.message);
          else if (result.kind === 'done') return;
        }
      }
      for (const payload of parser.flush()) {
        const result = extractDelta(payload);
        if (result.kind === 'content') yield result.text;
        else if (result.kind === 'error') throw new Error(result.message);
        else if (result.kind === 'done') return;
      }
    } finally {
      reader.releaseLock?.();
    }
  }

  /** POST /v1/models. Returns the `data` array (empty when absent). */
  async listModels({ token }: { token?: string | null } = {}): Promise<unknown[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    // The Dart client sent no body at all here, which is not valid JSON for
    // relays that parse the request; `{}` is accepted by both.
    const response = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
      method: 'POST',
      headers,
      body: '{}',
    });

    const text = await response.text();
    if (!response.ok) {
      throw new RelayHttpError(
        `models failed: HTTP ${response.status}`,
        response.status,
        text,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new RelayHttpError('models failed: non-JSON response', response.status, text);
    }
    const data = body.data;
    return Array.isArray(data) ? data : [];
  }
}

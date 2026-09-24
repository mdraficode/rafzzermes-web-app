import { describe, expect, it, vi } from 'vitest';
import {
  RelayClient,
  RelayHttpError,
  SseLineParser,
  extractDelta,
  webSocketUrlFor,
  type FetchLike,
  type WebSocketLike,
} from '../src/core/client/relayClient';
import { normalizeRelayBaseUrl } from '../src/core/config';

/* ------------------------------- helpers ------------------------------- */

/** Builds a streaming `Response` so the SSE reader path runs for real. */
function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    ...init,
  });
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  url = '';
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  /** Test driver: simulate a successful handshake. */
  open() {
    this.readyState = 1;
    this.onopen?.({ type: 'open' });
  }

  /** Test driver: simulate an inbound frame. */
  deliver(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

/* ------------------------------- tests -------------------------------- */

describe('normalizeRelayBaseUrl', () => {
  it('defaults a scheme-less value to https', () => {
    expect(normalizeRelayBaseUrl('relay.example.com')).toBe('https://relay.example.com');
  });

  it('preserves an explicit ws/http scheme and strips trailing slashes', () => {
    expect(normalizeRelayBaseUrl('http://79.76.61.69:9602/')).toBe('http://79.76.61.69:9602');
    expect(normalizeRelayBaseUrl('https://relay.example.com/base/')).toBe(
      'https://relay.example.com/base',
    );
  });

  it('drops query and hash, which would corrupt the path joins', () => {
    expect(normalizeRelayBaseUrl('https://relay.example.com/?token=abc#x')).toBe(
      'https://relay.example.com',
    );
  });

  it('rejects empty, non-URL and non-http values', () => {
    expect(normalizeRelayBaseUrl('')).toBeNull();
    expect(normalizeRelayBaseUrl('   ')).toBeNull();
    expect(normalizeRelayBaseUrl('not a url')).toBeNull();
    expect(normalizeRelayBaseUrl('ftp://relay.example.com')).toBeNull();
  });
});

describe('webSocketUrlFor', () => {
  it('upgrades https to wss and appends /sync', () => {
    expect(webSocketUrlFor('https://relay.example.com')).toBe('wss://relay.example.com/sync');
  });

  it('upgrades http to ws — the Dart client used the same endpoint', () => {
    expect(webSocketUrlFor('http://79.76.61.69:9602')).toBe('ws://79.76.61.69:9602/sync');
  });

  it('carries the token as a query parameter, as the relay expects', () => {
    expect(webSocketUrlFor('https://relay.example.com', 'a b&c')).toBe(
      'wss://relay.example.com/sync?token=a+b%26c',
    );
  });

  it('omits the token parameter entirely when there is no token', () => {
    expect(webSocketUrlFor('https://relay.example.com', null)).toBe(
      'wss://relay.example.com/sync',
    );
  });
});

describe('SseLineParser', () => {
  it('splits complete LF-terminated data lines and keeps the remainder buffered', () => {
    const parser = new SseLineParser();
    expect(parser.push('data: {"a":1}\ndata: {"b":')).toEqual(['{"a":1}']);
    expect(parser.push('2}\n')).toEqual(['{"b":2}']);
    expect(parser.flush()).toEqual([]);
  });

  it('handles CRLF framing, including a CRLF split across chunks', () => {
    const parser = new SseLineParser();
    expect(parser.push('data: one\r')).toEqual([]);
    expect(parser.push('\ndata: two\r\n')).toEqual(['one', 'two']);
  });

  it('ignores keep-alive comments and event/id/retry fields', () => {
    const parser = new SseLineParser();
    expect(parser.push(': ping\nevent: message\nid: 7\nretry: 100\ndata: real\n')).toEqual([
      'real',
    ]);
  });

  it('emits a trailing payload for a stream that ends without a newline', () => {
    const parser = new SseLineParser();
    expect(parser.push('data: last')).toEqual([]);
    expect(parser.flush()).toEqual(['last']);
  });

  it('does not carry state between flush calls', () => {
    const parser = new SseLineParser();
    parser.push('data: a\n');
    expect(parser.flush()).toEqual([]);
    expect(parser.push('data: b\n')).toEqual(['b']);
  });
});

describe('extractDelta', () => {
  it('reads the OpenAI chunk shape the Dart client parsed', () => {
    expect(extractDelta('{"choices":[{"delta":{"content":"Hello"}}]}')).toEqual({
      kind: 'content',
      text: 'Hello',
    });
  });

  it('treats [DONE] as end of stream', () => {
    expect(extractDelta('[DONE]')).toEqual({ kind: 'done' });
  });

  it('surfaces relay error frames instead of dropping them', () => {
    expect(extractDelta('{"error":"quota exceeded"}')).toEqual({
      kind: 'error',
      message: 'quota exceeded',
    });
    expect(extractDelta('{"error":{"message":"bad model"}}')).toEqual({
      kind: 'error',
      message: 'bad model',
    });
  });

  it('tolerates flatter relay shapes', () => {
    expect(extractDelta('{"delta":"a"}')).toEqual({ kind: 'content', text: 'a' });
    expect(extractDelta('{"content":"b"}')).toEqual({ kind: 'content', text: 'b' });
    expect(extractDelta('{"text":"c"}')).toEqual({ kind: 'content', text: 'c' });
    expect(extractDelta('{"token":"d"}')).toEqual({ kind: 'content', text: 'd' });
  });

  it('skips empty deltas, blank lines and unrecognised frames', () => {
    expect(extractDelta('')).toEqual({ kind: 'skip' });
    expect(extractDelta('{"choices":[{"delta":{"content":""}}]}')).toEqual({ kind: 'skip' });
    expect(extractDelta('{"choices":[]}')).toEqual({ kind: 'skip' });
    expect(extractDelta('{"unrelated":true}')).toEqual({ kind: 'skip' });
    expect(extractDelta('"just a string"')).toEqual({ kind: 'skip' });
  });

  it('skips malformed JSON rather than corrupting the transcript', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(extractDelta('<html>504</html>')).toEqual({ kind: 'skip' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('RelayClient.login', () => {
  const body = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it('POSTs the credentials and returns the parsed body', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => body({ token: 'tok-123' }));
    const client = new RelayClient({ baseUrl: 'https://relay.example.com', fetchImpl });

    await expect(
      client.login({ username: 'u', password: 'p', workspaceUrl: 'w' }),
    ).resolves.toEqual({ token: 'tok-123' });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://relay.example.com/auth/login');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({
      username: 'u',
      password: 'p',
      workspaceUrl: 'w',
    });
  });

  it('throws with the relay error message on a non-2xx response', async () => {
    const fetchImpl: FetchLike = async () => body({ error: 'bad credentials' }, 401);
    const client = new RelayClient({ baseUrl: 'https://relay.example.com', fetchImpl });

    await expect(client.login({ username: 'u', password: 'p' })).rejects.toThrow(
      'login failed: bad credentials',
    );
  });

  it('reports a non-JSON response body clearly (the Dart version threw a raw FormatException)', async () => {
    const fetchImpl: FetchLike = async () => new Response('<html>502</html>', { status: 502 });
    const client = new RelayClient({ baseUrl: 'https://relay.example.com', fetchImpl });

    await expect(client.login({ username: 'u', password: 'p' })).rejects.toBeInstanceOf(
      RelayHttpError,
    );
  });
});

describe('RelayClient.postChatStream', () => {
  it('yields content deltas in order and stops at [DONE]', async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
        'data: {"choices":[{"delta":{"content":"lo "}}]}\n',
        'data: {"choices":[{"delta":{}}]}\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n',
        'data: [DONE]\n',
        'data: {"choices":[{"delta":{"content":"ignored"}}]}\n',
      ]);
    const client = new RelayClient({ baseUrl: 'https://relay.example.com', fetchImpl });

    const tokens: string[] = [];
    for await (const token of client.postChatStream({ stream: true }, { token: 'tok' })) {
      tokens.push(token);
    }
    expect(tokens).toEqual(['Hel', 'lo ', 'world']);
  });

  it('reassembles a UTF-8 codepoint split across chunk boundaries', async () => {
    // "é" is 0xC3 0xA9 — split it deliberately between two chunks.
    const full = 'data: {"choices":[{"delta":{"content":"café ✓"}}]}\n';
    const bytes = new TextEncoder().encode(full);
    const splitAt = bytes.indexOf(0xc3) + 1;
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, splitAt));
            controller.enqueue(bytes.slice(splitAt));
            controller.close();
          },
        }),
        { status: 200 },
      );
    const client = new RelayClient({ baseUrl: 'https://relay.example.com', fetchImpl });

    const tokens: string[] = [];
    for await (const token of client.postChatStream({}, { token: 'tok' })) tokens.push(token);
    expect(tokens.join('')).toBe('café ✓');
  });

  it('parses a stream that ends without a trailing newline', async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"tail"}}]}']);
    const client = new RelayClient({ baseUrl: 'https://relay.example.com', fetchImpl });

    const tokens: string[] = [];
    for await (const token of client.postChatStream({}, { token: 'tok' })) tokens.push(token);
    expect(tokens).toEqual(['tail']);
  });

  it('sends the bearer token and throws on an error status', async () => {
    const fetchImpl = vi.fn<FetchLike>(
      async () => new Response('relay down', { status: 503 }),
    );
    const client = new RelayClient({ baseUrl: 'https://relay.example.com', fetchImpl });

    const iterate = async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.postChatStream({ stream: true }, { token: 'tok-9' })) {
        /* unreachable */
      }
    };

    await expect(iterate()).rejects.toThrow(/chat failed: HTTP 503/);
    expect(fetchImpl.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: 'Bearer tok-9',
      Accept: 'text/event-stream',
    });
  });

  it('propagates an in-stream error frame as a thrown error', async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n',
        'data: {"error":"model unavailable"}\n',
      ]);
    const client = new RelayClient({ baseUrl: 'https://relay.example.com', fetchImpl });

    const tokens: string[] = [];
    await expect(
      (async () => {
        for await (const token of client.postChatStream({}, { token: 't' })) tokens.push(token);
      })(),
    ).rejects.toThrow('model unavailable');
    expect(tokens).toEqual(['partial']);
  });

  it('stops cleanly when the request is aborted', async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    };
    const client = new RelayClient({ baseUrl: 'https://relay.example.com', fetchImpl });

    await expect(
      (async () => {
        for await (const _token of client.postChatStream({}, {
          token: 't',
          signal: controller.signal,
        })) {
          /* no tokens expected */
        }
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('RelayClient.listModels', () => {
  it('returns the data array', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ data: [{ id: 'hermes-3' }] }), { status: 200 });
    const client = new RelayClient({ baseUrl: 'https://relay.example.com', fetchImpl });
    await expect(client.listModels({ token: 't' })).resolves.toEqual([{ id: 'hermes-3' }]);
  });

  it('returns an empty array when the payload has no data field', async () => {
    const fetchImpl: FetchLike = async () => new Response('{}', { status: 200 });
    const client = new RelayClient({ baseUrl: 'https://relay.example.com', fetchImpl });
    await expect(client.listModels()).resolves.toEqual([]);
  });
});

describe('RelayClient WebSocket lifecycle', () => {
  function makeClient() {
    const sockets: FakeSocket[] = [];
    const client = new RelayClient({
      baseUrl: 'https://relay.example.com',
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        socket.url = url;
        sockets.push(socket);
        return socket;
      },
    });
    return { client, sockets };
  }

  it('connects to the wss /sync endpoint carrying the token', () => {
    const { client, sockets } = makeClient();
    client.connect({ token: 'tok-1' });
    expect(sockets[0]!.url).toBe(
      'wss://relay.example.com/sync?token=tok-1',
    );
    expect(client.isConnected).toBe(false); // not open until the handshake lands
  });

  it('reports open only after the handshake, then sends the catch-up frame', () => {
    const { client, sockets } = makeClient();
    const opened = vi.fn();
    client.onOpen = opened;
    client.connect({ token: 'tok-1' });

    expect(opened).not.toHaveBeenCalled();
    sockets[0]!.open();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(client.isConnected).toBe(true);

    client.sendSync({ lastSeq: 42 });
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'sync', lastSeq: 42 })]);
  });

  it('emits decoded events as [type, payload] tuples', () => {
    const { client, sockets } = makeClient();
    const events: Array<[string, Record<string, unknown>]> = [];
    client.onEvent((event) => events.push(event));
    client.connect({ token: 't' });
    sockets[0]!.open();
    sockets[0]!.deliver({ type: 'workflow_update', message: 'Deploying' });

    expect(events).toEqual([['workflow_update', { type: 'workflow_update', message: 'Deploying' }]]);
  });

  it('defaults the event name to "unknown" when the frame has no type', () => {
    const { client, sockets } = makeClient();
    const names: string[] = [];
    client.onEvent(([name]) => names.push(name));
    client.connect({ token: 't' });
    sockets[0]!.open();
    sockets[0]!.deliver({ message: 'no type here' });
    expect(names).toEqual(['unknown']);
  });

  it('closes the previous socket instead of leaking it on repeated connect()', () => {
    const { client, sockets } = makeClient();
    client.connect({ token: 'a' });
    client.connect({ token: 'b' });

    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets[1]!.url).toContain('token=b');
  });

  it('reports an unintentional close but not a deliberate disconnect', () => {
    const { client, sockets } = makeClient();
    const closed = vi.fn();
    client.onClose = closed;

    client.connect({ token: 'a' });
    sockets[0]!.open();
    client.disconnect();
    expect(closed).not.toHaveBeenCalled();

    client.connect({ token: 'a' });
    sockets[1]!.open();
    sockets[1]!.onclose?.({ type: 'close' });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(client.isConnected).toBe(false);
  });

  it('ignores frames from a socket it has already replaced', () => {
    const { client, sockets } = makeClient();
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));

    client.connect({ token: 'a' });
    const stale = sockets[0]!;
    client.connect({ token: 'b' });
    stale.open();
    stale.deliver({ type: 'workflow_update' });

    expect(events).toEqual([]);
  });
});

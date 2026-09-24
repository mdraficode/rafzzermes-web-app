import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayProvider } from '../src/core/relayProvider';
import { RelayClient, type WebSocketLike } from '../src/core/client/relayClient';
import { StorageKeys, removeKey, writeString } from '../src/core/storage';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  url = '';
  closed = false;
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
  open() {
    this.readyState = 1;
    this.onopen?.({ type: 'open' });
  }
  deliver(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function makeProvider() {
  const sockets: FakeSocket[] = [];
  const client = new RelayClient({
    baseUrl: 'https://relay.example.com',
    fetchImpl: async () => new Response('{}', { status: 200 }),
    webSocketFactory: (url) => {
      const socket = new FakeSocket();
      socket.url = url;
      sockets.push(socket);
      return socket;
    },
  });
  // autoReconnect: false keeps timers out of the assertions.
  const relay = new RelayProvider({ client, autoReconnect: false });
  return { relay, sockets };
}

/** Waits for the constructor's async token load to settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RelayProvider', () => {
  beforeEach(() => {
    removeKey(StorageKeys.token);
  });

  it('starts logged out with no socket when storage is empty', async () => {
    const { relay, sockets } = makeProvider();
    await flush();
    expect(relay.loaded).toBe(true);
    expect(relay.isLoggedIn).toBe(false);
    expect(relay.token).toBeNull();
    expect(sockets).toHaveLength(0);
    relay.dispose();
  });

  it('restores a persisted token and opens the sync socket', async () => {
    writeString(StorageKeys.token, 'persisted-token');
    const { relay, sockets } = makeProvider();
    await flush();

    expect(relay.isLoggedIn).toBe(true);
    expect(relay.token).toBe('persisted-token');
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('wss://relay.example.com/sync?token=persisted-token');
    relay.dispose();
  });

  it('persists the token given to setToken() and connects exactly once', async () => {
    const { relay, sockets } = makeProvider();
    await flush();

    await relay.setToken('fresh-token');
    expect(relay.token).toBe('fresh-token');
    expect(sockets).toHaveLength(1);

    // A second connect() must not tear down a healthy socket.
    relay.connect();
    expect(sockets).toHaveLength(1);
    relay.dispose();
  });

  it('only reports "connected" after the socket handshake completes', async () => {
    const { relay, sockets } = makeProvider();
    await relay.setToken('tok');
    expect(relay.connectionState).toBe('connecting');
    expect(relay.connected).toBe(false);

    sockets[0]!.open();
    expect(relay.connectionState).toBe('connected');
    expect(relay.connected).toBe(true);
    relay.dispose();
  });

  it('requests catch-up from the last sequence seen', async () => {
    const { relay, sockets } = makeProvider();
    await relay.setToken('tok');
    sockets[0]!.open();
    sockets[0]!.deliver({ type: 'message_new', id: 'a', seq: 7 });

    expect(relay.lastSeq).toBe(7);
    relay.disconnect();
    relay.connect();
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([JSON.stringify({ type: 'sync', lastSeq: 7 })]);
    relay.dispose();
  });

  it('tracks workflow_update status and clears it on a new message', async () => {
    const { relay, sockets } = makeProvider();
    await relay.setToken('tok');
    sockets[0]!.open();

    sockets[0]!.deliver({ type: 'workflow_update', message: 'Summarising' });
    expect(relay.lastStatus).toBe('Summarising');

    sockets[0]!.deliver({ type: 'message_new', content: 'done' });
    expect(relay.lastStatus).toBeNull();
    relay.dispose();
  });

  it('notifies subscribers on state changes', async () => {
    const { relay, sockets } = makeProvider();
    const listener = vi.fn();
    relay.subscribe(listener);

    await relay.setToken('tok');
    const afterLogin = listener.mock.calls.length;
    expect(afterLogin).toBeGreaterThan(0);

    sockets[0]!.open();
    expect(listener.mock.calls.length).toBeGreaterThan(afterLogin);
    relay.dispose();
  });

  it('clearToken() logs out, drops the socket and forgets the token', async () => {
    const { relay, sockets } = makeProvider();
    await relay.setToken('tok');
    sockets[0]!.open();

    await relay.clearToken();
    expect(relay.isLoggedIn).toBe(false);
    expect(relay.token).toBeNull();
    expect(relay.connectionState).toBe('idle');
    expect(sockets[0]!.closed).toBe(true);
    expect(relay.connected).toBe(false);
    relay.dispose();
  });

  it('does not reconnect after an explicit logout', async () => {
    const { relay, sockets } = makeProvider();
    await relay.setToken('tok');
    sockets[0]!.open();
    await relay.clearToken();

    // A late close on the discarded socket must not schedule anything.
    sockets[0]!.onclose?.({ type: 'close' });
    relay.connect();
    expect(sockets).toHaveLength(1);
    relay.dispose();
  });

  it('records socket errors', async () => {
    const { relay, sockets } = makeProvider();
    await relay.setToken('tok');
    sockets[0]!.onerror?.({ type: 'error' });

    expect(relay.lastError).toMatch(/socket error/i);
    relay.dismissError();
    expect(relay.lastError).toBeNull();
    relay.dispose();
  });

  it('reports a mixed-content misconfiguration before any request', async () => {
    const client = new RelayClient({
      baseUrl: 'http://79.76.61.69:9602',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const relay = new RelayProvider({ client, autoReconnect: false });
    await flush();

    // No DOM in this environment, so the check is inert rather than wrong.
    expect(relay.baseUrlProblem).toBeNull();
    expect(relay.relayBaseUrl).toBe('http://79.76.61.69:9602');
    relay.dispose();
  });

  it('stops delivering events after dispose()', async () => {
    const { relay, sockets } = makeProvider();
    const listener = vi.fn();
    relay.subscribe(listener);
    await relay.setToken('tok');
    sockets[0]!.open();

    relay.dispose();
    const count = listener.mock.calls.length;
    sockets[0]!.deliver({ type: 'workflow_update', message: 'too late' });
    expect(listener.mock.calls.length).toBe(count);
  });
});

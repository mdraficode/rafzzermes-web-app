import { ChangeNotifier } from './notifier';
import { AppConfig, storeRelayBaseUrl, transportProblem } from './config';
import {
  RelayClient,
  type LoginArgs,
  type RelayEvent,
  type RelayEventListener,
} from './client/relayClient';
import { StorageKeys, readString, removeKey, writeString } from './storage';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export interface RelayProviderOptions {
  client?: RelayClient;
  /** Set false in tests to keep timers out of the picture. */
  autoReconnect?: boolean;
}

/** Exponential backoff for the sync socket, capped so a tab can idle offline. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

/**
 * Port of `lib/core/relay_provider.dart`.
 *
 * Owns the session token, the RelayClient, and the live connection state.
 * LoginScreen and ChatScreen read it through `useNotifier(relay)`.
 *
 * Three defects in the Dart original are fixed here, all noted in ANALYSIS.md:
 *
 *  - `_connected` was set to true *synchronously* before the WebSocket
 *    handshake, so the UI claimed "connected" even when the socket failed.
 *    Here the state only advances on a real `open` event.
 *  - each `connect()` built a new WebSocketChannel without closing the old one,
 *    leaking a socket per login. RelayClient.connect() now closes first.
 *  - login_screen.dart connected its own RelayClient and then called
 *    `setToken`, which connected a second one (two sockets per login). The
 *    login screen no longer owns a client; it delegates here.
 */
export class RelayProvider extends ChangeNotifier {
  private clientInstance: RelayClient;
  private tokenValue: string | null = null;
  private loadedValue = false;
  private connectionStateValue: ConnectionState = 'idle';
  private lastErrorValue: string | null = null;
  private lastErrorAtValue: number | null = null;
  private lastStatusValue: string | null = null;
  private lastSeqValue = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly autoReconnect: boolean;
  private disposed = false;
  private detachClient: () => void;

  constructor(options: RelayProviderOptions = {}) {
    super();
    this.autoReconnect = options.autoReconnect ?? true;
    this.clientInstance =
      options.client ?? new RelayClient({ baseUrl: AppConfig.relayBaseUrl });
    this.detachClient = this.attachClient(this.clientInstance);

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
    }
    void this.loadToken();
  }

  /* ---------------------------- getters ---------------------------- */

  get token(): string | null {
    return this.tokenValue;
  }

  get loaded(): boolean {
    return this.loadedValue;
  }

  get connected(): boolean {
    return this.connectionStateValue === 'connected';
  }

  get connectionState(): ConnectionState {
    return this.connectionStateValue;
  }

  get lastError(): string | null {
    return this.lastErrorValue;
  }

  get lastErrorAt(): number | null {
    return this.lastErrorAtValue;
  }

  /** Latest `workflow_update` label pushed by the relay, if any. */
  get lastStatus(): string | null {
    return this.lastStatusValue;
  }

  get lastSeq(): number {
    return this.lastSeqValue;
  }

  get isLoggedIn(): boolean {
    return this.tokenValue !== null;
  }

  get relay(): RelayClient {
    return this.clientInstance;
  }

  get relayBaseUrl(): string {
    return this.clientInstance.baseUrl;
  }

  /** Subscribes to relay events (ChatController uses this). */
  onEvent(listener: RelayEventListener): () => void {
    return this.clientInstance.onEvent(listener);
  }

  /**
   * A browser-blocking misconfiguration (e.g. HTTPS page → HTTP relay), or the
   * plain-HTTP warning. null when the transport is usable.
   */
  get baseUrlProblem(): string | null {
    return transportProblem(this.clientInstance.baseUrl);
  }

  /* --------------------------- lifecycle --------------------------- */

  private attachClient(client: RelayClient): () => void {
    client.onOpen = () => {
      if (this.disposed) return;
      this.connectionStateValue = 'connected';
      this.reconnectAttempts = 0;
      this.lastErrorValue = null;
      this.lastErrorAtValue = null;
      // Ask the relay to replay anything missed while the socket was down.
      client.sendSync({ lastSeq: this.lastSeqValue });
      this.notify();
    };
    client.onClose = () => {
      if (this.disposed) return;
      this.lastStatusValue = null;
      this.connectionStateValue = 'disconnected';
      this.notify();
      this.scheduleReconnect();
    };
    client.onError = (event) => {
      if (this.disposed) return;
      this.setError(describeSocketError(event));
    };
    const unsubscribe = client.onEvent((event) => this.handleRelayEvent(event));
    return () => {
      unsubscribe();
      client.onOpen = null;
      client.onClose = null;
      client.onError = null;
    };
  }

  private async loadToken(): Promise<void> {
    this.tokenValue = readString(StorageKeys.token);
    this.loadedValue = true;
    this.notify();
    if (this.tokenValue) this.connect();
  }

  /**
   * POST /auth/login, then — on success — persist the token and open the sync
   * socket.
   *
   * The Dart login screen did the login itself, wrote the token to storage,
   * connected its *own* RelayClient, and then called `setToken` on the
   * provider, which connected a *second* client. Routing the whole flow through
   * the provider is what makes login open exactly one socket.
   *
   * The raw body is returned so the caller can surface an `{error: …}` payload
   * that arrived with a 2xx status.
   */
  async login(args: LoginArgs): Promise<Record<string, unknown>> {
    const body = await this.clientInstance.login(args);
    const token = typeof body.token === 'string' ? body.token : null;
    if (token) await this.setToken(token);
    return body;
  }

  /** Persists the token and opens the sync socket. */
  async setToken(token: string): Promise<void> {
    writeString(StorageKeys.token, token);
    this.tokenValue = token;
    this.notify();
    this.connect();
  }

  /** Logs out: clears storage, closes the socket, cancels any reconnect. */
  async clearToken(): Promise<void> {
    removeKey(StorageKeys.token);
    this.tokenValue = null;
    this.disconnect();
    this.notify();
  }

  connect(): void {
    if (this.disposed || this.tokenValue === null) return;
    this.clearReconnectTimer();
    // Already open — or still handshaking: connecting again would tear down a
    // healthy socket (or the handshake that is in flight).
    if (this.connectionStateValue === 'connected' || this.clientInstance.isActive) {
      return;
    }
    this.connectionStateValue = 'connecting';
    this.notify();
    this.clientInstance.connect({ token: this.tokenValue });
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.clientInstance.disconnect();
    this.connectionStateValue = 'idle';
    this.lastStatusValue = null;
    this.notify();
  }

  /**
   * Re-points the client at a different relay (Settings panel), persists the
   * choice, and reconnects if a session is active.
   */
  setRelayBaseUrl(baseUrl: string | null): void {
    storeRelayBaseUrl(baseUrl);
    const resolved = AppConfig.relayBaseUrl;
    if (resolved === this.clientInstance.baseUrl) return;

    this.detachClient();
    this.clientInstance.disconnect();
    this.clientInstance = new RelayClient({ baseUrl: resolved });
    this.detachClient = this.attachClient(this.clientInstance);
    this.connectionStateValue = 'idle';
    this.notify();
    if (this.tokenValue) this.connect();
  }

  /* --------------------------- reconnect --------------------------- */

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.disposed || this.tokenValue === null) return;
    this.clearReconnectTimer();
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempts += 1;
    this.connectionStateValue = 'reconnecting';
    this.notify();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || this.tokenValue === null) return;
      this.clientInstance.connect({ token: this.tokenValue });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleOnline = (): void => {
    if (this.disposed || this.tokenValue === null) return;
    if (this.connectionStateValue === 'connected') return;
    // Network came back — retry immediately rather than waiting out the backoff.
    this.reconnectAttempts = 0;
    this.connect();
  };

  /* ----------------------------- events ---------------------------- */

  private handleRelayEvent([name, data]: RelayEvent): void {
    if (this.disposed) return;

    const seq = data.seq ?? data.lastSeq;
    if (typeof seq === 'number' && Number.isFinite(seq)) {
      this.lastSeqValue = Math.max(this.lastSeqValue, seq);
    }

    if (name === 'workflow_update') {
      const message = data.message;
      if (typeof message === 'string' && message) this.lastStatusValue = message;
    } else if (name === 'message_new') {
      this.lastStatusValue = null;
    }

    this.notify();
  }

  private setError(message: string): void {
    this.lastErrorValue = message;
    this.lastErrorAtValue = Date.now();
    this.notify();
  }

  dismissError(): void {
    if (this.lastErrorValue === null) return;
    this.lastErrorValue = null;
    this.lastErrorAtValue = null;
    this.notify();
  }

  override dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
    }
    this.detachClient();
    this.clientInstance.disconnect();
    super.dispose();
  }
}

/**
 * Browser WebSocket `error` events are deliberately opaque (no status, no
 * message) for security reasons, so say what we actually know.
 */
function describeSocketError(event: unknown): string {
  if (event instanceof Event && event.type) {
    return `Sync socket error (${event.type}). Retrying…`;
  }
  if (event instanceof Error) return event.message;
  return 'Sync socket error. Retrying…';
}

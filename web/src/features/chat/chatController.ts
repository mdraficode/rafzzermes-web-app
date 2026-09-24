import { ChangeNotifier } from '../../core/notifier';
import { RelayHttpError, type RelayEvent } from '../../core/client/relayClient';
import { describeTransportFailure } from '../../core/errors';
import type { RelayProvider } from '../../core/relayProvider';

export type MessageRole = 'user' | 'assistant' | 'status';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** Ghost message: auto-clears when the assistant replies (Dart `transient`). */
  transient: boolean;
}

let messageCounter = 0;
function nextId(): string {
  messageCounter += 1;
  return `m${messageCounter}`;
}

/**
 * Port of `_ChatScreenState` in `lib/features/chat/chat_screen.dart`, lifted out
 * of the widget so the transcript survives re-renders and is testable.
 *
 * Behaviour is unchanged:
 *   - start empty (the Dart version's hard-coded fake history was already removed)
 *   - optimistic user bubble + an assistant bubble filled in by the SSE stream
 *   - `workflow_update` events push a transient status bubble, de-duplicated by
 *     label, which is swept away when a real message lands
 *   - failures are written into the assistant bubble as `Error: …`
 */
export class ChatController extends ChangeNotifier {
  readonly sessionId: string;
  private readonly relay: RelayProvider;
  private messagesValue: ChatMessage[] = [];
  private streamingValue = false;
  private errorValue: string | null = null;
  private pendingAssistantId: string | null = null;
  private inFlight: AbortController | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private seenRemoteIds = new Set<string>();
  private disposed = false;

  constructor(relay: RelayProvider, sessionId = 'default') {
    super();
    this.relay = relay;
    this.sessionId = sessionId;
    this.unsubscribeEvents = relay.onEvent((event) => this.handleRelayEvent(event));
  }

  get messages(): readonly ChatMessage[] {
    return this.messagesValue;
  }

  get streaming(): boolean {
    return this.streamingValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  /* --------------------------- mutations --------------------------- */

  /** Dart `_pushStatus`: dedupe by label, render `<emoji> <label> (<action> in progress…)`. */
  pushStatus(label: string, emoji = '⏳', action = 'assigned'): void {
    if (!label) return;
    const already = this.messagesValue.some(
      (message) => message.role === 'status' && message.content.includes(label),
    );
    if (already) return;
    this.messagesValue = [
      ...this.messagesValue,
      {
        id: nextId(),
        role: 'status',
        content: `${emoji} ${label} (${action} in progress…)`,
        transient: true,
      },
    ];
    this.notify();
  }

  /** Dart `_clearTransient`. */
  clearTransient(): void {
    const remaining = this.messagesValue.filter((message) => !message.transient);
    if (remaining.length === this.messagesValue.length) return;
    this.messagesValue = remaining;
    this.notify();
  }

  clearError(): void {
    if (this.errorValue === null) return;
    this.errorValue = null;
    this.notify();
  }

  /** Dart `_send`. */
  async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text || this.disposed) return;

    this.cancelStream();
    this.clearTransient();
    this.errorValue = null;

    const userMessage: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: text,
      transient: false,
    };
    const assistantMessage: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      transient: false,
    };
    this.pendingAssistantId = assistantMessage.id;
    this.messagesValue = [...this.messagesValue, userMessage, assistantMessage];
    this.streamingValue = true;
    this.notify();

    const token = this.relay.token;
    if (token === null) {
      this.replaceAssistant('Error: not authenticated');
      this.finishStream();
      return;
    }

    const controller = new AbortController();
    this.inFlight = controller;

    const payload = {
      messages: [{ role: 'user', content: text }],
      stream: true,
    };

    try {
      const stream = this.relay.relay.postChatStream(payload, {
        token,
        signal: controller.signal,
      });
      for await (const delta of stream) {
        if (this.disposed || controller.signal.aborted) break;
        this.appendToAssistant(delta);
      }
      if (!controller.signal.aborted) {
        const pending = this.findPending();
        // A stream that yielded nothing: say so rather than leaving a blank bubble.
        if (pending && pending.content.length === 0) {
          this.replaceAssistant('Error: the relay closed the stream without sending a reply.');
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) this.replaceAssistant(formatStreamError(error));
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
      this.finishStream();
    }
  }

  cancelStream(): void {
    this.inFlight?.abort();
    this.inFlight = null;
    if (this.streamingValue) this.finishStream();
  }

  private finishStream(): void {
    this.pendingAssistantId = null;
    this.streamingValue = false;
    this.clearTransient();
    this.notify();
  }

  private findPending(): ChatMessage | undefined {
    if (this.pendingAssistantId === null) return undefined;
    return this.messagesValue.find((message) => message.id === this.pendingAssistantId);
  }

  private appendToAssistant(delta: string): void {
    const id = this.pendingAssistantId;
    if (id === null) return;
    this.messagesValue = this.messagesValue.map((message) =>
      message.id === id ? { ...message, content: message.content + delta } : message,
    );
    this.notify();
  }

  private replaceAssistant(content: string): void {
    const id = this.pendingAssistantId;
    if (id === null) return;
    this.messagesValue = this.messagesValue.map((message) =>
      message.id === id ? { ...message, content } : message,
    );
    this.notify();
  }

  /* ----------------------------- events ---------------------------- */

  private handleRelayEvent([name, data]: RelayEvent): void {
    if (this.disposed) return;
    if (name === 'workflow_update') {
      const message = data.message;
      this.pushStatus(typeof message === 'string' && message ? message : 'Working...');
    } else if (name === 'message_new') {
      this.clearTransient();
      this.absorbRemoteMessage(data);
    } else if (name === 'error') {
      const message = data.message ?? data.error;
      if (typeof message === 'string' && message) this.errorValue = message;
      this.notify();
    }
  }

  /**
   * The relay's `message_new` frame also serves as replay for anything missed
   * while the socket was down (`sendSync` catch-up). The Dart client ignored
   * the payload, so this stays conservative: it appends only when the frame
   * carries usable text, de-duplicating by `id` when present and otherwise by
   * exact match against the newest message.
   */
  private absorbRemoteMessage(data: Record<string, unknown>): void {
    const id = typeof data.id === 'string' ? data.id : null;
    if (id !== null) {
      if (this.seenRemoteIds.has(id)) return;
      this.seenRemoteIds.add(id);
    }

    const candidate = [data.content, data.text, data.message].find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (!candidate) return;

    // Already shown locally — this is the echo of our own send.
    const last = this.messagesValue[this.messagesValue.length - 1];
    if (last && last.content === candidate && !last.transient) return;

    const role: MessageRole = data.role === 'user' ? 'user' : 'assistant';
    this.messagesValue = [
      ...this.messagesValue,
      { id: nextId(), role, content: candidate, transient: false },
    ];
    this.notify();
  }

  override dispose(): void {
    this.disposed = true;
    this.cancelStream();
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    super.dispose();
  }
}

/** Mirrors the Dart `'Error: $err'` wording, with HTTP detail when available. */
function formatStreamError(error: unknown): string {
  if (error instanceof RelayHttpError) return `Error: ${error.message}`;
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'Error: request cancelled';
    return `Error: ${describeTransportFailure(error)}`;
  }
  return `Error: ${String(error)}`;
}

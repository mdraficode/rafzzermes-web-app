import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayProvider } from '../src/core/relayProvider';
import { RelayClient, type FetchLike, type WebSocketLike } from '../src/core/client/relayClient';
import { ChatController } from '../src/features/chat/chatController';
import { StorageKeys, removeKey } from '../src/core/storage';

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  url = '';
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  deliver(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function setup(fetchImpl: FetchLike) {
  const sockets: FakeSocket[] = [];
  const client = new RelayClient({
    baseUrl: 'https://relay.example.com',
    fetchImpl,
    webSocketFactory: (url) => {
      const socket = new FakeSocket();
      socket.url = url;
      sockets.push(socket);
      return socket;
    },
  });
  const relay = new RelayProvider({ client, autoReconnect: false });
  const chat = new ChatController(relay, 'default');
  return { relay, chat, sockets };
}

const okChat = (chunks: string[]): FetchLike => async () => sseResponse(chunks);
const reply = (text: string) => `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n`;

describe('ChatController', () => {
  beforeEach(() => {
    removeKey(StorageKeys.token);
  });

  it('starts with an empty transcript', () => {
    const { relay, chat } = setup(okChat([]));
    // The Dart widget once shipped hard-coded fake history; it must stay gone.
    expect(chat.messages).toHaveLength(0);
    chat.dispose();
    relay.dispose();
  });

  it('appends the user message and streams the reply into the assistant bubble', async () => {
    const { relay, chat } = setup(okChat([reply('Hel'), reply('lo'), 'data: [DONE]\n']));
    await relay.setToken('tok');

    await chat.send('  hello there  ');

    expect(chat.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello there'],
      ['assistant', 'Hello'],
    ]);
    expect(chat.streaming).toBe(false);
    chat.dispose();
    relay.dispose();
  });

  it('ignores empty and whitespace-only sends', async () => {
    const { relay, chat } = setup(okChat([]));
    await relay.setToken('tok');

    await chat.send('   ');
    expect(chat.messages).toHaveLength(0);
    chat.dispose();
    relay.dispose();
  });

  it('reports an unauthenticated send inside the assistant bubble', async () => {
    const { relay, chat } = setup(okChat([]));
    await chat.send('hi');

    expect(chat.messages[1]!.content).toBe('Error: not authenticated');
    chat.dispose();
    relay.dispose();
  });

  it('surfaces an HTTP failure as an Error bubble rather than hanging', async () => {
    const { relay, chat } = setup(async () => new Response('nope', { status: 500 }));
    await relay.setToken('tok');

    await chat.send('hi');
    expect(chat.messages[1]!.content).toMatch(/^Error: chat failed: HTTP 500/);
    chat.dispose();
    relay.dispose();
  });

  it('surfaces an unreachable relay as a readable message', async () => {
    const { relay, chat } = setup(async () => {
      throw new TypeError('Failed to fetch');
    });
    await relay.setToken('tok');

    await chat.send('hi');
    expect(chat.messages[1]!.content).toMatch(/could not reach the relay/i);
    chat.dispose();
    relay.dispose();
  });

  it('notes an empty stream instead of leaving a blank bubble', async () => {
    const { relay, chat } = setup(okChat(['data: [DONE]\n']));
    await relay.setToken('tok');

    await chat.send('hi');
    expect(chat.messages[1]!.content).toMatch(/closed the stream without sending a reply/);
    chat.dispose();
    relay.dispose();
  });

  describe('workflow_update status bubbles', () => {
    it('renders the label with the Dart wording and de-duplicates repeats', async () => {
      const { relay, chat, sockets } = setup(okChat([]));
      await relay.setToken('tok');

      sockets[0]!.deliver({ type: 'workflow_update', message: 'Scraping docs' });
      sockets[0]!.deliver({ type: 'workflow_update', message: 'Scraping docs' });
      sockets[0]!.deliver({ type: 'workflow_update', message: 'Indexing' });

      const statuses = chat.messages.filter((m) => m.role === 'status');
      expect(statuses.map((m) => m.content)).toEqual([
        '⏳ Scraping docs (assigned in progress…)',
        '⏳ Indexing (assigned in progress…)',
      ]);
      expect(statuses.every((m) => m.transient)).toBe(true);
      chat.dispose();
      relay.dispose();
    });

    it('falls back to "Working..." for a message-less update', async () => {
      const { relay, chat, sockets } = setup(okChat([]));
      await relay.setToken('tok');
      sockets[0]!.deliver({ type: 'workflow_update' });

      expect(chat.messages[0]!.content).toContain('Working...');
      chat.dispose();
      relay.dispose();
    });

    it('sweeps transient statuses away when a real message arrives', async () => {
      const { relay, chat, sockets } = setup(okChat([]));
      await relay.setToken('tok');

      sockets[0]!.deliver({ type: 'workflow_update', message: 'Thinking' });
      expect(chat.messages).toHaveLength(1);

      sockets[0]!.deliver({ type: 'message_new', id: 'm-1', content: 'Here you go' });
      expect(chat.messages.map((m) => m.role)).toEqual(['assistant']);
      expect(chat.messages[0]!.content).toBe('Here you go');
      chat.dispose();
      relay.dispose();
    });
  });

  describe('remote message replay', () => {
    it('de-duplicates by event id', async () => {
      const { relay, chat, sockets } = setup(okChat([]));
      await relay.setToken('tok');

      sockets[0]!.deliver({ type: 'message_new', id: 'x', content: 'once' });
      sockets[0]!.deliver({ type: 'message_new', id: 'x', content: 'once' });

      expect(chat.messages).toHaveLength(1);
      chat.dispose();
      relay.dispose();
    });

    it('ignores the echo of a message already shown locally', async () => {
      const { relay, chat, sockets } = setup(okChat([reply('ok'), 'data: [DONE]\n']));
      await relay.setToken('tok');
      await chat.send('ping');

      sockets[0]!.deliver({ type: 'message_new', content: 'ok' });
      expect(chat.messages.map((m) => m.content)).toEqual(['ping', 'ok']);
      chat.dispose();
      relay.dispose();
    });

    it('ignores frames with no usable text', async () => {
      const { relay, chat, sockets } = setup(okChat([]));
      await relay.setToken('tok');
      sockets[0]!.deliver({ type: 'message_new', id: 'y' });
      expect(chat.messages).toHaveLength(0);
      chat.dispose();
      relay.dispose();
    });
  });

  it('cancels an in-flight stream when a new message is sent', async () => {
    let firstAborted = false;
    const fetchImpl: FetchLike = async (_url, init) => {
      const signal = init?.signal;
      if (signal?.aborted) firstAborted = true;
      signal?.addEventListener('abort', () => {
        firstAborted = true;
      });
      return sseResponse([reply('partial')]);
    };
    const { relay, chat } = setup(fetchImpl);
    await relay.setToken('tok');

    const first = chat.send('one');
    await Promise.resolve();
    chat.cancelStream();
    await first;

    expect(firstAborted).toBe(true);
    chat.dispose();
    relay.dispose();
  });

  it('notifies listeners as the transcript changes', async () => {
    const { relay, chat } = setup(okChat([reply('hi'), 'data: [DONE]\n']));
    const listener = vi.fn();
    chat.subscribe(listener);
    await relay.setToken('tok');

    await chat.send('x');
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
    chat.dispose();
    relay.dispose();
  });

  it('stops reacting to relay events after dispose()', async () => {
    const { relay, chat, sockets } = setup(okChat([]));
    await relay.setToken('tok');
    chat.dispose();

    sockets[0]!.deliver({ type: 'workflow_update', message: 'after dispose' });
    expect(chat.messages).toHaveLength(0);
    relay.dispose();
  });
});

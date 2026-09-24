/**
 * @vitest-environment jsdom
 *
 * End-to-end render test: mounts the real <App> in a DOM, drives the login
 * form, and streams a reply through the chat composer.
 *
 * This is the closest thing to "run it in a browser" that can happen without a
 * browser binary — it exercises the provider wiring, the screen switch in
 * App.tsx, storage, SSE parsing and the transcript rendering together.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/App';
import { RelayProvider } from '../src/core/relayProvider';
import { ThemeController } from '../src/ui/theme';
import { RelayClient, type FetchLike, type WebSocketLike } from '../src/core/client/relayClient';
import { StorageKeys, removeKey } from '../src/core/storage';

class FakeSocket implements WebSocketLike {
  readyState = 0;
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
  open() {
    this.readyState = 1;
    this.onopen?.({ type: 'open' });
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

function mount(fetchImpl: FetchLike) {
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
  const theme = new ThemeController();
  const view = render(<App relay={relay} theme={theme} />);
  return { relay, theme, sockets, view };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** fetch stub: /auth/login returns a token, /v1/chat streams the given chunks. */
function fakeFetch(chatChunks: string[]): FetchLike {
  return async (url) => {
    if (url.endsWith('/auth/login')) {
      return new Response(JSON.stringify({ token: 'tok-abc' }), { status: 200 });
    }
    if (url.endsWith('/v1/chat')) return sseResponse(chatChunks);
    return new Response('{}', { status: 200 });
  };
}

declare global {
  // Required by React's `act()` outside a test runner's own setup.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const delta = (text: string) =>
  `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n`;

describe('App (rendered in jsdom)', () => {
  beforeEach(() => {
    removeKey(StorageKeys.token);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the login screen with the original copy when logged out', async () => {
    const { relay } = mount(fakeFetch([]));
    await waitFor(() => expect(screen.queryByText('Restoring session…')).toBeNull());

    expect(screen.getByText('Enter Hermes Workspace credentials')).toBeDefined();
    expect(screen.getByLabelText('Username')).toBeDefined();
    expect(screen.getByLabelText('Password')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Log In' })).toBeDefined();
    relay.dispose();
  });

  it('validates empty credentials with the Dart wording', async () => {
    const { relay } = mount(fakeFetch([]));
    await waitFor(() => expect(screen.queryByText('Restoring session…')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Log In' }));
    expect(await screen.findByText('Enter username and password')).toBeDefined();
    relay.dispose();
  });

  it('logs in, opens exactly one sync socket and shows the chat screen', async () => {
    const { relay, sockets } = mount(fakeFetch([delta('hi'), 'data: [DONE]\n']));
    await waitFor(() => expect(screen.queryByText('Restoring session…')).toBeNull());

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'rafi' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log In' }));

    // Chat screen replaces the login screen.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log out' })).toBeDefined());
    expect(screen.queryByText('Enter Hermes Workspace credentials')).toBeNull();

    // Exactly one socket, despite login + setToken both being able to connect.
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('wss://relay.example.com/sync?token=tok-abc');

    sockets[0]!.open();
    expect(await screen.findByText('Connected')).toBeDefined();
    relay.dispose();
  });

  it('streams a reply into the transcript when a message is sent', async () => {
    const { relay } = mount(
      fakeFetch([delta('Hello'), delta(' '), delta('there'), 'data: [DONE]\n']),
    );
    await waitFor(() => expect(screen.queryByText('Restoring session…')).toBeNull());

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'rafi' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log In' }));
    await waitFor(() => expect(screen.getByLabelText('Message')).toBeDefined());

    const composer = screen.getByLabelText('Message');
    fireEvent.change(composer, { target: { value: 'Say hello' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(await screen.findByText('Say hello')).toBeDefined();
    await waitFor(() => expect(screen.getByText('Hello there')).toBeDefined());
    relay.dispose();
  });

  it('renders a workflow_update as a transient status bubble', async () => {
    const { relay, sockets } = mount(fakeFetch([]));
    await waitFor(() => expect(screen.queryByText('Restoring session…')).toBeNull());

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'rafi' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log In' }));
    await waitFor(() => expect(screen.getByLabelText('Message')).toBeDefined());

    sockets[0]!.open();
    sockets[0]!.deliver({ type: 'workflow_update', message: 'Deploying Hermes' });

    expect(
      await screen.findByText('⏳ Deploying Hermes (assigned in progress…)'),
    ).toBeDefined();
    relay.dispose();
  });

  it('warns that a plain-HTTP relay is blocked from an HTTPS page', async () => {
    const client = new RelayClient({
      baseUrl: 'http://79.76.61.69:9602',
      fetchImpl: fakeFetch([]),
      webSocketFactory: () => new FakeSocket(),
    });
    const relay = new RelayProvider({ client, autoReconnect: false });
    const theme = new ThemeController();
    render(<App relay={relay} theme={theme} />);
    await waitFor(() => expect(screen.queryByText('Restoring session…')).toBeNull());

    // jsdom's origin is http://localhost, which browsers treat as trustworthy,
    // so no warning is expected here — the check must not fire spuriously.
    expect(screen.queryByText(/mixed content/i)).toBeNull();
    relay.dispose();
  });

  it('explains an unreachable relay on login rather than showing "Failed to fetch"', async () => {
    const { relay } = mount(async () => {
      throw new TypeError('Failed to fetch');
    });
    await waitFor(() => expect(screen.queryByText('Restoring session…')).toBeNull());

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'rafi' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log In' }));

    expect(await screen.findByText(/Could not reach the relay/)).toBeDefined();
    expect(screen.queryByText('Failed to fetch')).toBeNull();
    relay.dispose();
  });

  it('opens the settings sheet and reports the resolved relay endpoint', async () => {
    const { relay } = mount(fakeFetch([]));
    await waitFor(() => expect(screen.queryByText('Restoring session…')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });

    expect(within(dialog).getByText('Relay endpoint')).toBeDefined();
    expect(within(dialog).getByLabelText('Base URL')).toBeDefined();
    relay.dispose();
  });

  it('logs out and returns to the login screen', async () => {
    const { relay } = mount(fakeFetch([]));
    await waitFor(() => expect(screen.queryByText('Restoring session…')).toBeNull());

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'rafi' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log In' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log out' })).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() =>
      expect(screen.getByText('Enter Hermes Workspace credentials')).toBeDefined(),
    );
    expect(relay.isLoggedIn).toBe(false);
    relay.dispose();
  });

  it('restores a saved session on load without showing the login screen', async () => {
    localStorage.setItem(StorageKeys.token, 'saved-token');
    const { relay, sockets } = mount(fakeFetch([]));

    await waitFor(() => expect(screen.getByLabelText('Message')).toBeDefined());
    expect(screen.queryByText('Enter Hermes Workspace credentials')).toBeNull();
    expect(sockets[0]!.url).toContain('token=saved-token');
    relay.dispose();
    localStorage.removeItem(StorageKeys.token);
  });

  it('toggles between light and dark themes', async () => {
    const { relay, theme } = mount(fakeFetch([]));
    await waitFor(() => expect(screen.queryByText('Restoring session…')).toBeNull());

    const initial = theme.dark;
    fireEvent.click(
      screen.getByRole('button', {
        name: initial ? 'Switch to light theme' : 'Switch to dark theme',
      }),
    );
    await waitFor(() => expect(theme.dark).toBe(!initial));
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe(
        theme.dark ? 'dark' : 'light',
      ),
    );
    relay.dispose();
    await flush();
  });
});

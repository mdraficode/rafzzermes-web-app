import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNotifier } from '../../core/useNotifier';
import { relayDisplayHost } from '../../core/config';
import type { RelayProvider } from '../../core/relayProvider';
import type { ChatController, ChatMessage } from './chatController';
import { Banner, IconButton, Spinner } from '../../ui/components';
import {
  LogOutIcon,
  MoonIcon,
  SendIcon,
  SettingsIcon,
  SunIcon,
} from '../../ui/icons';
import type { ThemeController } from '../../ui/theme';

export interface ChatScreenProps {
  relay: RelayProvider;
  chat: ChatController;
  theme: ThemeController;
  onOpenSettings: () => void;
}

/** Port of the `ChatScreen` body (formerly `_ChatScreenState.build`, a bare Column). */
export function ChatScreen({ relay, chat, theme, onOpenSettings }: ChatScreenProps) {
  useNotifier(relay);
  useNotifier(chat);
  useNotifier(theme);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  const messageCount = chat.messages.length;
  const lastContent = chat.messages[messageCount - 1]?.content ?? '';
  const streaming = chat.streaming;

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedToBottom) return;
    node.scrollTop = node.scrollHeight;
  }, [messageCount, lastContent, streaming, pinnedToBottom]);

  // Reset the pin whenever the transcript is emptied (logout / new session).
  useEffect(() => {
    if (messageCount === 0) setPinnedToBottom(true);
  }, [messageCount]);

  function handleScroll() {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setPinnedToBottom(distance < 80);
  }

  return (
    <>
      <header className="app-bar">
        <div className="app-bar-brand">
          <span className="app-bar-mark" aria-hidden>
            R
          </span>
          <div className="app-bar-titles">
            <h1 className="app-bar-title">Rafzzermes App</h1>
            {/* The relay host, not the connection state — that is the pill's job. */}
            <p className="app-bar-subtitle">{relayDisplayHost(relay.relayBaseUrl)}</p>
          </div>
        </div>
        <div className="app-bar-spacer" />
        <div className="app-bar-actions">
          <span className={`status-pill status-pill-${relay.connectionState}`}>
            <span className="status-dot" aria-hidden />
            {connectionLabel(relay.connectionState)}
          </span>
          <IconButton
            label={theme.dark ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => theme.toggle()}
          >
            {theme.dark ? <SunIcon /> : <MoonIcon />}
          </IconButton>
          <IconButton label="Settings" onClick={onOpenSettings}>
            <SettingsIcon />
          </IconButton>
          <IconButton label="Log out" onClick={() => void relay.clearToken()}>
            <LogOutIcon />
          </IconButton>
        </div>
      </header>

      {relay.baseUrlProblem || relay.lastError || chat.error ? (
        <div className="chat-notices">
          {relay.baseUrlProblem ? (
            <Banner tone="warning" title="Relay transport">
              {relay.baseUrlProblem}
            </Banner>
          ) : null}
          {relay.lastError ? (
            <Banner tone="error" onDismiss={() => relay.dismissError()}>
              {relay.lastError}
            </Banner>
          ) : null}
          {chat.error ? (
            <Banner tone="error" onDismiss={() => chat.clearError()}>
              {chat.error}
            </Banner>
          ) : null}
        </div>
      ) : null}

      <div className="app-body" style={{ position: 'relative' }}>
        <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
          <div className="chat-scroll-inner">
            {chat.messages.length === 0 ? <EmptyState /> : null}
            {chat.messages.map((message) => (
              <MessageBubble key={message.id} message={message} streaming={streaming} />
            ))}
          </div>
        </div>

        {!pinnedToBottom ? (
          <IconButton
            label="Scroll to latest"
            className="chat-scroll-btn"
            onClick={() => {
              const node = scrollRef.current;
              if (node) node.scrollTop = node.scrollHeight;
              setPinnedToBottom(true);
            }}
          >
            <SendIcon style={{ transform: 'rotate(90deg)' }} />
          </IconButton>
        ) : null}

        <Composer
          streaming={streaming}
          connected={relay.connected}
          onSend={(text) => void chat.send(text)}
        />
      </div>
    </>
  );
}

function connectionLabel(state: RelayProvider['connectionState']): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'disconnected':
      return 'Offline';
    default:
      return 'Idle';
  }
}

function EmptyState() {
  return (
    <div className="chat-empty">
      <div className="chat-empty-mark" aria-hidden>
        💬
      </div>
      <p className="chat-empty-title">No messages yet</p>
      <p className="chat-empty-text">
        Ask the Hermes workspace anything. Replies stream in as the relay produces them.
      </p>
    </div>
  );
}

/** Port of `_MessageBubble` + `_StatusBubble`. */
function MessageBubble({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  if (message.role === 'status') return <StatusBubble content={message.content} />;

  const isUser = message.role === 'user';
  // The Dart client wrote failures into the assistant bubble as "Error: …";
  // they are rendered with the error tone so they are not mistaken for a reply.
  const isError = !isUser && message.content.startsWith('Error:');
  const isEmpty = message.content.length === 0;

  const classes = [
    'bubble',
    isUser ? 'bubble-user' : 'bubble-assistant',
    isError ? 'bubble-error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`msg-row ${isUser ? 'msg-row-user' : 'msg-row-assistant'}`}>
      <div className={classes}>
        {isEmpty && streaming && !isUser ? (
          <span className="typing" role="status" aria-label="Waiting for reply">
            <span />
            <span />
            <span />
          </span>
        ) : (
          message.content
        )}
      </div>
    </div>
  );
}

/** Port of `_StatusBubble`: spinner + transient `workflow_update` label. */
function StatusBubble({ content }: { content: string }) {
  return (
    <div className="msg-row msg-row-status">
      <div className="bubble bubble-status" role="status">
        <Spinner size={14} />
        <span>{content}</span>
      </div>
    </div>
  );
}

/** Port of `_Composer` (`hintText: 'Type a message…'` + filled send IconButton). */
function Composer({
  streaming,
  connected,
  onSend,
}: {
  streaming: boolean;
  connected: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  function submit() {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText('');
    const node = inputRef.current;
    if (node) node.style.height = 'auto';
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends (Dart: TextInputAction.send); Shift+Enter inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="composer">
      <div className="composer-row">
        <div className="composer-input-wrap">
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={1}
            value={text}
            placeholder="Type a message…"
            aria-label="Message"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <IconButton
          label="Send message"
          variant="solid"
          onClick={submit}
          disabled={text.trim().length === 0}
        >
          {streaming ? <Spinner size={16} /> : <SendIcon />}
        </IconButton>
      </div>
      <p className="composer-hint">
        <span>Enter sends · Shift+Enter adds a line break</span>
        <span>{connected ? '' : 'Not connected to the relay'}</span>
      </p>
    </div>
  );
}

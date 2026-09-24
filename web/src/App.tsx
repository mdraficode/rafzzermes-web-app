import { useEffect, useState } from 'react';
import { useNotifier } from './core/useNotifier';
import type { RelayProvider } from './core/relayProvider';
import type { ThemeController } from './ui/theme';
import { ChatController } from './features/chat/chatController';
import { ChatScreen } from './features/chat/ChatScreen';
import { LoginScreen } from './features/auth/LoginScreen';
import { SettingsPanel } from './features/settings/SettingsPanel';
import { Spinner } from './ui/components';

export interface AppProps {
  relay: RelayProvider;
  theme: ThemeController;
}

/**
 * Root widget — the counterpart of `RafzzermesApp` in `lib/main.dart`.
 *
 * `main.dart` chose the home screen with
 *   `home: relay.isLoggedIn ? ChatScreen(sessionId: 'default') : LoginScreen(...)`
 * which is reproduced exactly: an active token renders the chat, otherwise the
 * login screen.
 */
export function App({ relay, theme }: AppProps) {
  useNotifier(relay);
  useNotifier(theme);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chat, setChat] = useState<ChatController | null>(null);

  // Theme is a `data-theme` attribute on <html>; the stylesheet does the rest.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme.dark ? 'dark' : 'light');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.dark ? '#101828' : '#ffffff');
  }, [theme.dark]);

  // One ChatController per session, mirroring ChatScreen's per-session state.
  useEffect(() => {
    if (!relay.isLoggedIn) {
      setChat(null);
      return;
    }
    const controller = new ChatController(relay, 'default');
    setChat(controller);
    return () => {
      controller.dispose();
      setChat(null);
    };
  }, [relay, relay.isLoggedIn]);

  return (
    <div className="app-shell">
      {!relay.loaded ? (
        <div className="boot-screen">
          <Spinner size={26} label="Loading session" />
          <span>Restoring session…</span>
        </div>
      ) : relay.isLoggedIn && chat ? (
        <ChatScreen
          relay={relay}
          chat={chat}
          theme={theme}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <LoginScreen
          relay={relay}
          theme={theme}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      {settingsOpen ? (
        <SettingsPanel relay={relay} theme={theme} onClose={() => setSettingsOpen(false)} />
      ) : null}
    </div>
  );
}

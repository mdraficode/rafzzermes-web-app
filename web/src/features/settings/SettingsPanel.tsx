import { useEffect, useRef, useState } from 'react';
import { useNotifier } from '../../core/useNotifier';
import {
  AppConfig,
  DEFAULT_RELAY_BASE_URL,
  normalizeRelayBaseUrl,
  transportProblem,
} from '../../core/config';
import { webSocketUrlFor } from '../../core/client/relayClient';
import type { RelayProvider } from '../../core/relayProvider';
import type { ThemeController } from '../../ui/theme';
import { Banner, IconButton, PrimaryButton, TextField } from '../../ui/components';
import { CloseIcon } from '../../ui/icons';

export interface SettingsPanelProps {
  relay: RelayProvider;
  theme: ThemeController;
  onClose: () => void;
}

/**
 * Web-only addition (no Android counterpart).
 *
 * The APK hard-baked its relay endpoint at build time via
 * `--dart-define=RELAY_BASE_URL`, which is not something a deployed web page
 * can do. This panel is that build flag made runtime-editable, plus a plain
 * view of the live session so connection problems are diagnosable.
 */
export function SettingsPanel({ relay, theme, onClose }: SettingsPanelProps) {
  useNotifier(relay);
  useNotifier(theme);

  const [draft, setDraft] = useState(relay.relayBaseUrl);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDraft(relay.relayBaseUrl);
  }, [relay.relayBaseUrl]);

  // Escape closes; focus moves into the panel for keyboard users.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function applyUrl(event: React.FormEvent) {
    event.preventDefault();
    const normalized = normalizeRelayBaseUrl(draft);
    if (!normalized) {
      setDraftError('That does not look like a valid URL.');
      return;
    }
    setDraftError(null);
    relay.setRelayBaseUrl(normalized);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  }

  function resetUrl() {
    relay.setRelayBaseUrl(null);
    setDraft(AppConfig.relayBaseUrl);
    setDraftError(null);
  }

  const preview = normalizeRelayBaseUrl(draft);
  const previewProblem = preview ? transportProblem(preview) : null;

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="sheet-header">
          <h2 className="sheet-title">Settings</h2>
          <IconButton label="Close settings" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </header>

        <div className="sheet-body">
          <section className="sheet-section">
            <h3 className="sheet-section-title">Relay endpoint</h3>
            <p className="sheet-section-desc">
              The Android build baked this in with{' '}
              <code>--dart-define=RELAY_BASE_URL</code>. Here it is stored in this browser, so
              you can point the app at any relay without a rebuild.
            </p>

            <form onSubmit={applyUrl}>
              <TextField
                label="Base URL"
                value={draft}
                onValueChange={setDraft}
                placeholder="https://relay.example.com"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
                errorText={draftError ?? undefined}
                hint={
                  preview && !previewProblem
                    ? `WebSocket: ${webSocketUrlFor(preview)}`
                    : undefined
                }
              />
              <div className="row-actions">
                <PrimaryButton type="submit" onClick={applyUrl}>
                  Save &amp; reconnect
                </PrimaryButton>
                <button type="button" className="btn btn-secondary" onClick={resetUrl}>
                  Use default
                </button>
              </div>
            </form>

            {previewProblem ? <Banner tone="warning">{previewProblem}</Banner> : null}
            {saved ? <Banner tone="success">Relay endpoint updated.</Banner> : null}
            <p className="sheet-section-desc" style={{ marginTop: 10 }}>
              Built-in default: <code>{DEFAULT_RELAY_BASE_URL}</code>
            </p>
          </section>

          <section className="sheet-section">
            <h3 className="sheet-section-title">Session</h3>
            <div className="kv">
              <span className="kv-key">Connection</span>
              <span className="kv-value">{relay.connectionState}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Relay</span>
              <span className="kv-value">{relay.relayBaseUrl}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Last sync seq</span>
              <span className="kv-value">{relay.lastSeq}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Token</span>
              <span className="kv-value">
                {relay.token
                  ? showToken
                    ? relay.token
                    : `${relay.token.slice(0, 6)}…${relay.token.slice(-4)}`
                  : 'none'}
              </span>
            </div>
            {relay.token ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowToken((value) => !value)}
                style={{ marginTop: 10 }}
              >
                {showToken ? 'Hide token' : 'Reveal token'}
              </button>
            ) : null}
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  relay.disconnect();
                  relay.connect();
                }}
                disabled={!relay.isLoggedIn}
              >
                Reconnect
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  void relay.clearToken();
                  onClose();
                }}
                disabled={!relay.isLoggedIn}
              >
                Log out
              </button>
            </div>
          </section>

          <section className="sheet-section">
            <h3 className="sheet-section-title">Appearance</h3>
            <div className="kv">
              <span className="kv-key">Theme</span>
              <span className="kv-value">{theme.dark ? 'dark' : 'light'}</span>
            </div>
            <div className="row-actions">
              <button type="button" className="btn btn-secondary" onClick={() => theme.toggle()}>
                Toggle theme
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => theme.useSystemPreference()}
              >
                Match system
              </button>
            </div>
          </section>

          <section className="sheet-section">
            <h3 className="sheet-section-title">About</h3>
            <p className="sheet-section-desc">
              Rafzzermes Web App — browser client for the Rafzzermes relay. Same protocol as the
              Android Flutter client: WebSocket <code>/sync</code> plus HTTP{' '}
              <code>/auth/login</code>, <code>/v1/chat</code> (SSE) and <code>/v1/models</code>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

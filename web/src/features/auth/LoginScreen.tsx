import { useState, type FormEvent } from 'react';
import { useNotifier } from '../../core/useNotifier';
import { pageIsInsecure } from '../../core/config';
import { describeTransportFailure } from '../../core/errors';
import { persistentStorageAvailable } from '../../core/storage';
import type { RelayProvider } from '../../core/relayProvider';
import type { ThemeController } from '../../ui/theme';
import { Banner, IconButton, PrimaryButton, TextField } from '../../ui/components';
import { EyeIcon, EyeOffIcon, MoonIcon, SettingsIcon, SunIcon } from '../../ui/icons';

export interface LoginScreenProps {
  relay: RelayProvider;
  theme: ThemeController;
  onOpenSettings: () => void;
}

/**
 * Port of `lib/features/auth/login_screen.dart`.
 *
 * Same copy, same validation, same error surface. One structural change: the
 * Dart screen built its own `RelayClient`, logged in with it, connected it, and
 * then handed the token to `RelayProvider` — which connected a *second* socket
 * on a second client. This screen now owns no client at all; it calls
 * `relay.login(...)` and the provider is the single owner of the session.
 */
export function LoginScreen({ relay, theme, onOpenSettings }: LoginScreenProps) {
  useNotifier(relay);
  useNotifier(theme);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const transport = relay.baseUrlProblem;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedUser = username.trim();
    const trimmedPass = password.trim();

    // Dart: `if (username.isEmpty || password.isEmpty)`.
    if (!trimmedUser || !trimmedPass) {
      setFieldError('Enter username and password');
      return;
    }

    setFieldError(null);
    setFailure(null);
    setLoading(true);
    try {
      const body = await relay.login({
        username: trimmedUser,
        password: trimmedPass,
      });
      // A successful HTTP response can still carry an error payload.
      const token = typeof body.token === 'string' ? body.token : null;
      if (!token) {
        const detail = body.error;
        setFailure(typeof detail === 'string' && detail ? detail : 'Login failed');
        return;
      }
      // relay.login() already persisted the token and opened the socket — do
      // not connect again here, or the handshake in flight is replaced.
      setPassword('');
    } catch (error) {
      setFailure(describeTransportFailure(error));
    } finally {
      setLoading(false);
    }
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
            <p className="app-bar-subtitle">Web client</p>
          </div>
        </div>
        <div className="app-bar-spacer" />
        <div className="app-bar-actions">
          <IconButton
            label={theme.dark ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => theme.toggle()}
          >
            {theme.dark ? <SunIcon /> : <MoonIcon />}
          </IconButton>
          <IconButton label="Settings" onClick={onOpenSettings}>
            <SettingsIcon />
          </IconButton>
        </div>
      </header>

      <div className="login-scroll">
        <div className="login-card">
          <div className="login-mark" aria-hidden>
            R
          </div>
          <h2 className="login-title">Sign in</h2>
          <p className="login-subtitle">Enter Hermes Workspace credentials</p>

          {transport ? <Banner tone="warning">{transport}</Banner> : null}
          {failure ? <Banner tone="error">{failure}</Banner> : null}

          <form onSubmit={handleSubmit} noValidate>
            <TextField
              label="Username"
              value={username}
              onValueChange={setUsername}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              placeholder="username"
            />

            <TextField
              label="Password"
              value={password}
              onValueChange={setPassword}
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              enterKeyHint="go"
              placeholder="••••••••"
              errorText={fieldError ?? undefined}
              trailing={
                <IconButton
                  label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((visible) => !visible)}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </IconButton>
              }
            />

            <div className="login-form-actions">
              <PrimaryButton type="submit" fullWidth loading={loading} disabled={loading}>
                Log In
              </PrimaryButton>
            </div>
          </form>

          <p className="login-footnote">
            Relay: <code>{relay.relayBaseUrl}</code>
          </p>
          {pageIsInsecure() ? (
            <p className="login-footnote">
              This page is not served over HTTPS, so the session token travels in the clear.
            </p>
          ) : null}
          {!persistentStorageAvailable ? (
            <p className="login-footnote">
              Browser storage is unavailable, so you will need to sign in again after a refresh.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}

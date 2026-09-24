import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RelayProvider } from './core/relayProvider';
import { ThemeController } from './ui/theme';
import { normalizeRelayBaseUrl, storeRelayBaseUrl } from './core/config';
import './styles/app.css';

/**
 * Deep link: `?relay=https://relay.example.com` points this browser at a relay
 * and remembers it, so a deployment can hand out one URL that just works.
 * Passing `?relay=default` clears the override.
 */
function applyRelayFromQuery(): void {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('relay');
  if (value === null) return;
  if (value === 'default' || value === '') {
    storeRelayBaseUrl(null);
    return;
  }
  const normalized = normalizeRelayBaseUrl(value);
  if (normalized) storeRelayBaseUrl(normalized);
  else console.warn('[rafzzermes] ignoring invalid ?relay= value', value);
}

applyRelayFromQuery();

// Module-scope singletons: created once, so React StrictMode's double-render in
// development cannot spin up two RelayProviders (each of which opens a socket).
const relay = new RelayProvider();
const theme = new ThemeController();

const container = document.getElementById('root');
if (!container) throw new Error('#root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App relay={relay} theme={theme} />
  </StrictMode>,
);

// Surface the live connection state to tooling/debugging.
window.addEventListener('beforeunload', () => relay.dispose());

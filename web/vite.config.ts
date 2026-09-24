import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves this repo at https://<user>.github.io/rafzzermes-web-app/,
// so the production bundle must be built with that path prefix. Override with
// VITE_BASE (e.g. VITE_BASE=/ for a custom domain or a root-hosted deploy).
const base = process.env.VITE_BASE ?? '/rafzzermes-web-app/';

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    // Bind every interface so the sandbox/container preview proxy can reach it.
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The preview proxy serves from https://<port>-<sandboxId>.e2b.app, a
    // different origin from the dev server's own host. Vite rejects unknown
    // Host headers and iframes are blocked unless explicitly allowed.
    allowedHosts: true,
    cors: true,
    headers: {
      // Never let a proxy frame the app (clickjacking) except our own preview.
      'X-Content-Type-Options': 'nosniff',
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
});

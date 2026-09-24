import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The relay client and store logic are browser-agnostic; the few
    // browser-only paths (window/localStorage) are guarded and covered by
    // falling back to their no-DOM behaviour.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    reporters: ['default'],
  },
});

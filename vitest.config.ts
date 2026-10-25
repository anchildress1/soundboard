import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  // Svelte 5 resolves its server build under Node; components need the browser entry to mount.
  resolve: { conditions: ['browser', ...defaultClientConditions] },
  test: {
    // Unit tests run real SQL on PGlite instead of mocking the database module. Exact match only:
    // db.test.ts imports `#src/lib/server/core/db.js` to reach the real module past this alias.
    alias: [
      {
        find: /^#lib\/server\/core\/db\.js$/,
        replacement: fileURLToPath(new URL('tests/helpers/db.ts', import.meta.url)),
      },
    ],
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['./tests/vitest-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,svelte}'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 80,
      },
    },
  },
});

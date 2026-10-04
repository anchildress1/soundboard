import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  // Svelte 5 resolves its server build under Node; components need the browser entry to mount.
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/vitest-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,svelte}'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/vitest-setup.ts'],
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

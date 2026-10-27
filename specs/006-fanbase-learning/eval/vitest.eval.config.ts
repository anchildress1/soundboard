import { defineConfig } from 'vitest/config';

// Unmocked fetch and no Sentry mock: this talks to Gemini. Run it by hand with GEMINI_API_KEY set.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['specs/006-fanbase-learning/eval/eval.test.ts'],
    testTimeout: 240_000,
  },
});

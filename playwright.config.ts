import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    // A machine with a preinstalled Chromium that doesn't match this Playwright's build (Claude Code
    // cloud sessions, which can't download browsers) points here instead.
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
      : {}),
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'node tests/e2e/fakes/model.ts',
      url: 'http://127.0.0.1:4174/ready',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm build && pnpm preview',
      url: 'http://localhost:4173',
      reuseExistingServer: false,
      // Fake Google Cloud clients and database seeded with fixture jobs (vite.config.ts).
      env: {
        E2E_FAKES: '1',
        MODEL_URL: 'http://127.0.0.1:4174',
        GCP_PROJECT_ID: 'e2e',
        GCS_BUCKET: 'e2e',
        SESSION_SECRET: 'e2e-session-secret',
        SIGNUP_MODE: 'invite',
        KMS_KEY: 'projects/e2e/locations/us-central1/keyRings/soundboard/cryptoKeys/refresh-tokens',
        // The E2E build swaps in PGlite (tests/e2e/fakes/db.ts); these only satisfy the env shape.
        DATABASE_URL: 'postgres://e2e@localhost/e2e',
        DATABASE_URL_UNPOOLED: 'postgres://e2e@localhost/e2e',
      },
    },
  ],
});

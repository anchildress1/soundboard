import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

// Workers reload this config with the runner's env, so the first load's random secret carries over
// and the server and tests/e2e/session.ts sign with the same key.
const sessionSecret = (process.env.E2E_SESSION_SECRET ??= randomBytes(32).toString('base64url'));

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
      // Its own process: the browser's PUTs and the app server's storage calls must reach one state.
      command: 'node tests/e2e/fakes/gcs-session.ts',
      url: 'http://localhost:4174',
      reuseExistingServer: false,
    },
    {
      // The preloads answer Gemini HTTP and the artist channel's upload reads inside the preview
      // server, so the real SDK and clients run.
      command:
        "pnpm build && NODE_OPTIONS='--import ./tests/e2e/fakes/gemini.ts --import ./tests/e2e/fakes/youtube.ts' pnpm preview",
      url: 'http://localhost:4173',
      reuseExistingServer: false,
      // Fake Google Cloud clients, window media and database seeded with fixture jobs (vite.config.ts).
      env: {
        E2E_FAKES: '1',
        GEMINI_API_KEY: 'e2e-not-a-key',
        YOUTUBE_API_KEY: 'e2e-not-a-key',
        // The channel tests/e2e/fakes/youtube.ts answers for.
        FLR_CHANNEL_ID: 'UC-e2e-artist',
        GCP_PROJECT_ID: 'e2e',
        GCS_BUCKET: 'e2e',
        SESSION_SECRET: sessionSecret,
        SIGNUP_MODE: 'invite',
        KMS_KEY: 'projects/e2e/locations/us-central1/keyRings/soundboard/cryptoKeys/refresh-tokens',
        // The E2E build swaps in PGlite (tests/e2e/fakes/db.ts); these only satisfy the env shape.
        DATABASE_URL: 'postgres://e2e@localhost/e2e',
        DATABASE_URL_UNPOOLED: 'postgres://e2e@localhost/e2e',
      },
    },
  ],
});

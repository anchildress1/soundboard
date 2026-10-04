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
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    // Fixed test identities, so header.spec.ts can sign session cookies for each kind of user.
    env: {
      SESSION_SECRET: 'e2e-session-secret',
      ALLOWLIST_EMAILS: 'nathan@e2e.test',
      DEMO_EMAILS: 'demo@e2e.test',
    },
  },
});

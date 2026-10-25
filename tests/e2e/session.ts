import { createHmac, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';

/** Seeded in tests/e2e/fakes/fixtures.ts: A is linked to FLR and connected, B is unlinked. */
export const USER_A = 'uid-a';
export const USER_B = 'uid-b';

// Mirrors #lib/server/auth sign() with the E2E server's SESSION_SECRET (playwright.config.ts).
export function sessionCookie(uid: string): string {
  const session = { uid, sid: randomBytes(16).toString('base64url'), exp: Date.now() + 3_600_000 };
  const body = Buffer.from(JSON.stringify(session)).toString('base64url');
  const mac = createHmac('sha256', 'e2e-session-secret').update(body).digest('base64url');
  return `${body}.${mac}`;
}

export async function signIn(page: Page, uid: string): Promise<void> {
  await page
    .context()
    .addCookies([{ name: 'sb_session', value: sessionCookie(uid), url: 'http://localhost:4173' }]);
}

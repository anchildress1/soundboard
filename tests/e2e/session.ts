import { createHmac, randomBytes } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';

/**
 * Seeded in tests/e2e/fakes/fixtures.ts: A is linked to FLR and connected, B has no profile, and C
 * has a non-Nathan profile and its own connected channel. The upload user owns no fixture jobs:
 * each upload test makes its own through `/new`.
 */
export const USER_A = 'uid-a';
export const USER_B = 'uid-b';
export const USER_C = 'uid-c';
export const USER_UPLOAD = 'uid-upload';

const DEVICE: Record<string, string> = { chromium: 'desktop', mobile: 'pixel' };

/** The project's own user with no profile, for tests that save one. */
export const newUser = ({ project }: TestInfo) => `uid-new-${DEVICE[project.name]}`;
/** The project's own user with a profile, for tests that edit it. */
export const renameUser = ({ project }: TestInfo) => `uid-rename-${DEVICE[project.name]}`;
/** The project's own users with one pending voice proposal: one to approve, one to race on. */
export const brandUser = ({ project }: TestInfo) => `uid-brand-${DEVICE[project.name]}`;
export const raceUser = ({ project }: TestInfo) => `uid-race-${DEVICE[project.name]}`;
/** The project's own user with no guides and C's connected channel, for tests that propose. */
export const proposeUser = ({ project }: TestInfo) => `uid-propose-${DEVICE[project.name]}`;

// Mirrors #lib/server/auth sign() with the E2E server's SESSION_SECRET (playwright.config.ts).
export function sessionCookie(uid: string): string {
  const secret = process.env.E2E_SESSION_SECRET;
  if (!secret) throw new Error('E2E_SESSION_SECRET is unset; run through playwright.config.ts');
  const session = { uid, sid: randomBytes(16).toString('base64url'), exp: Date.now() + 3_600_000 };
  const body = Buffer.from(JSON.stringify(session)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export async function signIn(page: Page, uid: string): Promise<void> {
  await page
    .context()
    .addCookies([{ name: 'sb_session', value: sessionCookie(uid), url: 'http://localhost:4173' }]);
}

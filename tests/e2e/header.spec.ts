import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

// Mirrors $lib/server/auth sign(): base64url JSON body, then its HMAC with the session secret.
function sessionCookie(email: string): string {
  const body = Buffer.from(JSON.stringify({ email, exp: Date.now() + 3_600_000 })).toString(
    'base64url',
  );
  const mac = createHmac('sha256', 'e2e-session-secret').update(body).digest('base64url');
  return `${body}.${mac}`;
}

async function signIn(page: Page, email: string) {
  await page
    .context()
    .addCookies([
      { name: 'sb_session', value: sessionCookie(email), url: 'http://localhost:4173' },
    ]);
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const [who, email, control] of [
  ['a signed-out visitor', null, 'Sign in'],
  ['Nathan', 'nathan@e2e.test', 'Sign out'],
  ['the demo account', 'demo@e2e.test', 'Sign out'],
] as const) {
  test(`keeps the header controls clear of the wordmark for ${who}`, async ({ page }) => {
    if (email) await signIn(page, email);
    await page.goto('/');
    const header = page.getByRole('banner');
    await expect(header.getByText(control)).toBeVisible();
    const wordmark = await page.getByRole('heading', { level: 1 }).boundingBox();
    const bar = await header.locator('.bar').boundingBox();
    expect(wordmark && bar).toBeTruthy();
    expect(overlaps(wordmark!, bar!)).toBe(false);
    await expect(page.getByText('Release agent · Flies Like Robots')).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
}

test('the skip link moves focus to the page content', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#content')).toBeFocused();
});

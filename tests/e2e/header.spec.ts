import { expect, test } from '@playwright/test';
import { signIn, USER_A, USER_B } from './session';

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const [who, uid, brand, signOut] of [
  ['a signed-out visitor', null, 0, 0],
  ['Nathan', USER_A, 1, 1],
  ['an unlinked user', USER_B, 0, 1],
] as const) {
  test(`keeps the header controls clear of the wordmark for ${who}`, async ({ page }) => {
    if (uid) await signIn(page, uid);
    await page.goto('/');
    const header = page.getByRole('banner');
    await expect(header.getByRole('link', { name: 'Brand guide' })).toHaveCount(brand);
    await expect(header.getByRole('button', { name: 'Sign out' })).toHaveCount(signOut);
    const wordmark = await page.getByRole('heading', { level: 1 }).boundingBox();
    const bar = await header.locator('.bar').boundingBox();
    expect(wordmark && bar).toBeTruthy();
    expect(overlaps(wordmark!, bar!)).toBe(false);
    await expect(page.getByText('Flies Like Robots · Release agent')).toBeVisible();
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

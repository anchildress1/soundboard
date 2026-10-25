import { expect, test } from '@playwright/test';
import { signIn, USER_A, USER_B } from './session';

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const [who, uid, artist] of [
  ['a signed-out user', null, false],
  ['Nathan', USER_A, true],
  ['a user without a profile', USER_B, false],
] as const) {
  test(`keeps the header controls clear of the wordmark for ${who}`, async ({ page }) => {
    if (uid) await signIn(page, uid);
    await page.goto('/');
    const header = page.getByRole('banner');
    const wordmark = await header
      .getByRole('link', { name: 'Soundboard', exact: true })
      .boundingBox();
    const control = uid
      ? header.getByRole('button', { name: 'Menu' })
      : header.getByText('Invite only');
    const box = await control.boundingBox();
    expect(wordmark && box).toBeTruthy();
    expect(overlaps(wordmark!, box!)).toBe(false);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);

    if (!uid) {
      await expect(header.getByRole('button', { name: 'Menu' })).toHaveCount(0);
      return;
    }
    await control.click();
    const menu = page.locator('#menu');
    await expect(menu.getByRole('link', { name: 'Connections' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Brand', exact: true })).toHaveCount(
      artist ? 1 : 0,
    );
    await expect(menu.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });
}

test('the menu links work and close behind the navigation', async ({ page }) => {
  await signIn(page, USER_A);
  await page.goto('/');
  await page.getByRole('button', { name: 'Menu' }).click();
  const menu = page.locator('#menu');
  await menu.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL('/settings');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await expect(menu).toBeHidden();
});

test('Escape closes the menu', async ({ page }) => {
  await signIn(page, USER_B);
  await page.goto('/');
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.locator('#menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu')).toBeHidden();
});

test('the skip link moves focus to the page content', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#content')).toBeFocused();
});

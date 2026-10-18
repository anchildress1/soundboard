import { expect, test } from '@playwright/test';
import { signIn, USER_A, USER_B } from './session';

test.describe('brand guide', () => {
  test('sends a signed-out visitor home and refuses its API', async ({ page, request }) => {
    const response = await request.get('/brand', { maxRedirects: 0 });
    expect([response.status(), response.headers().location]).toEqual([303, '/']);
    expect((await request.post('/api/brand/propose')).status()).toBe(401);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Brand guide' })).toHaveCount(0);
  });

  test('is a 404 for a user not linked to the artist', async ({ page }) => {
    await signIn(page, USER_B);
    expect((await page.goto('/brand'))?.status()).toBe(404);
    expect((await page.request.post('/api/brand/propose')).status()).toBe(404);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Brand guide' })).toHaveCount(0);
  });

  test('opens for Nathan from the header, with no channel connect links', async ({ page }) => {
    await signIn(page, USER_A);
    await page.goto('/');
    await page.getByRole('link', { name: 'Brand guide' }).click();
    await expect(page).toHaveURL('/brand');
    await expect(page.getByRole('heading', { name: /Approved guide/ })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: /connect/i })).toHaveCount(0);
  });
});

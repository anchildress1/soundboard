import { expect, test } from '@playwright/test';
import { signIn, USER_A, USER_B } from './session';

test.describe('brand guide', () => {
  test('sends a signed-out user home and refuses its API', async ({ page, request, baseURL }) => {
    const response = await request.get('/brand', { maxRedirects: 0 });
    expect([response.status(), response.headers().location]).toEqual([303, '/']);
    // A browser sends Origin on every POST; SvelteKit refuses a bodyless POST without one.
    const sameOrigin = { headers: { origin: baseURL! } };
    expect((await request.post('/api/brand/propose', sameOrigin)).status()).toBe(401);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Brand guide' })).toHaveCount(0);
  });

  test('is a 404 for a user not linked to the artist', async ({ page, baseURL }) => {
    await signIn(page, USER_B);
    expect((await page.goto('/brand'))?.status()).toBe(404);
    const sameOrigin = { headers: { origin: baseURL! } };
    expect((await page.request.post('/api/brand/propose', sameOrigin)).status()).toBe(404);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Brand guide' })).toHaveCount(0);
  });

  test('opens for Nathan from the header, with no channel connect links', async ({ page }) => {
    await signIn(page, USER_A);
    await page.goto('/');
    await page.getByRole('link', { name: 'Brand guide' }).click();
    await expect(page).toHaveURL('/brand');
    await expect(page.getByRole('heading', { name: /Approved guide/ })).toBeVisible();
  });

  test('waits on a busy model and keeps asking, storing no proposal', async ({ page }) => {
    await signIn(page, USER_A);
    await page.goto('/brand');
    const proposals = () =>
      page.waitForResponse((response) => response.url().endsWith('/api/brand/propose'));
    const first = proposals();
    await page.getByRole('button', { name: 'Propose' }).click();
    // The preload answers the brand model call with a 429 after the upload reads.
    expect(await (await first).json()).toEqual({ wait: 'model busy' });
    await expect(page.getByRole('button', { name: 'model busy' })).toBeDisabled();
    expect(await (await proposals()).json()).toEqual({ wait: 'model busy' });
    await expect(page.getByLabel(/^Statement/)).toHaveCount(0);
  });
});

import { expect, test } from '@playwright/test';

test('home page renders the Soundboard heading', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Soundboard');
  await expect(page.getByRole('heading', { level: 1, name: 'Soundboard' })).toBeVisible();
});

test('health endpoint reports ok', async ({ request }) => {
  const response = await request.get('/health');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ ok: true });
});

import { expect, test } from '@playwright/test';

test.describe('brand guide', () => {
  test('is a 404 for a signed-out visitor, with no footer link to it', async ({
    page,
    request,
  }) => {
    expect((await request.get('/brand')).status()).toBe(404);
    expect((await request.post('/api/brand/propose')).status()).toBe(404);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Brand guide' })).toHaveCount(0);
  });
});

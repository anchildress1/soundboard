import { expect, test } from '@playwright/test';

test.describe('home page', () => {
  test('renders the Soundboard frame', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Soundboard');
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText('Soundboard');
    await expect(heading.getByRole('link', { name: 'Soundboard' })).toHaveAttribute('href', '/');
    await expect(page.getByText('Release agent · Flies Like Robots')).toBeVisible();
  });

  test('keeps Analyze disabled with no file picked', async ({ page }) => {
    await page.goto('/');
    const analyze = page.getByRole('button', { name: 'Analyze' });
    await expect(analyze).toBeDisabled();
    await page.getByLabel(/^Song title/).fill('PeekaBoo');
    await expect(analyze).toBeDisabled();
    await expect(page.getByText('up to 5 min')).toBeVisible();
  });

  test('lets dev.to frame the page', async ({ request }) => {
    const response = await request.get('/');
    expect(response.ok()).toBe(true);
    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp).toContain('frame-ancestors');
    expect(csp).toContain("'self'");
    expect(csp).toContain('https://dev.to');
    expect(csp).toContain('https://*.dev.to');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('sets zero cookies for a signed-out visitor', async ({ page, context }) => {
    const response = await page.goto('/');
    expect(response?.headers()['set-cookie']).toBeUndefined();
    await page.waitForLoadState('networkidle');
    expect(await context.cookies()).toEqual([]);
  });

  test('stacks the tape above the form on phones and side by side on desktop', async ({
    page,
  }, testInfo) => {
    // Measure the settled layout: the sections ease in on load, a beat apart.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const tape = await page.getByRole('region', { name: 'The video' }).boundingBox();
    const form = await page.getByRole('form', { name: 'Start a run' }).boundingBox();
    expect(tape && form).toBeTruthy();
    if (testInfo.project.name === 'mobile') {
      expect(tape!.y + tape!.height).toBeLessThanOrEqual(form!.y);
      expect(Math.abs(tape!.x - form!.x)).toBeLessThan(2);
    } else {
      expect(tape!.x + tape!.width).toBeLessThanOrEqual(form!.x);
      expect(Math.abs(tape!.y - form!.y)).toBeLessThan(2);
    }
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
});

test('health endpoint reports ok', async ({ request }) => {
  const response = await request.get('/health');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ ok: true });
});

import { expect, test } from '@playwright/test';
import { signIn, USER_B } from './session';

test.describe('home page', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, USER_B);
  });

  test('renders the Soundboard frame', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Soundboard');
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText('Soundboard');
    await expect(heading.getByRole('link', { name: 'Soundboard' })).toHaveAttribute('href', '/');
    await expect(page.getByText('Flies Like Robots · Release agent')).toBeVisible();
  });

  test('keeps Analyze disabled with no file picked', async ({ page }) => {
    await page.goto('/');
    const analyze = page.getByRole('button', { name: 'Analyze' });
    await expect(analyze).toBeDisabled();
    await page.getByLabel(/^Song title/).fill('PeekaBoo');
    await expect(analyze).toBeDisabled();
    await expect(page.getByText('up to 15 min')).toBeVisible();
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

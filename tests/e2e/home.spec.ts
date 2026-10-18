import { expect, test } from '@playwright/test';
import { signIn, USER_A, USER_B } from './session';

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

test.describe('job list', () => {
  test("lists only the signed-in user's runs and continues one", async ({ page }) => {
    await signIn(page, USER_B);
    await page.goto('/');
    const runs = page.getByRole('region', { name: 'Your runs' });
    await expect(runs.getByRole('listitem')).toHaveCount(1);
    await expect(runs.getByRole('listitem')).toContainText('Vaporgram');
    await expect(runs.getByRole('listitem')).toContainText('Needs review');
    await runs.getByRole('link', { name: 'Continue Vaporgram' }).click();
    await expect(page).toHaveURL('/jobs/e2e-b-review');
    await expect(page.getByLabel(/^Title/)).toHaveValue('Vaporgram');
  });

  test('sends a client navigation home once the session is gone', async ({ page }) => {
    await signIn(page, USER_B);
    await page.goto('/');
    const runs = page.getByRole('region', { name: 'Your runs' });
    await expect(runs.getByRole('link', { name: 'Continue Vaporgram' })).toBeVisible();
    await page.context().clearCookies();
    await runs.getByRole('link', { name: 'Continue Vaporgram' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByLabel(/^Title/)).toHaveCount(0);
  });

  test('continues a run whose media expired, keeping its details', async ({ page }) => {
    await signIn(page, USER_A);
    await page.goto('/');
    await page.getByRole('link', { name: 'Continue Gone Song' }).click();
    await expect(page).toHaveURL('/jobs/e2e-expired');
    await expect(page.getByRole('note')).toContainText('upload it again');
    await expect(page.getByLabel(/^Title/)).toHaveValue('PeekaBoo (Official Video)');
  });

  test("leaves another user's runs and every Short off the list", async ({ page }) => {
    await signIn(page, USER_A);
    await page.goto('/');
    const runs = page.getByRole('region', { name: 'Your runs' });
    await expect(runs.getByRole('link', { name: 'Continue PeekaBoo' }).first()).toBeVisible();
    await expect(runs).not.toContainText('Vaporgram');
    await expect(runs.locator('a[href="/jobs/e2e-cut-short"]')).toHaveCount(0);
    await expect(runs.locator('a[href="/jobs/e2e-cut"]')).toHaveCount(1);
  });
});

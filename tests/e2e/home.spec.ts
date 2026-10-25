import { expect, test } from '@playwright/test';
import { signIn, USER_A, USER_B } from './session';

const START = 'Start a new release';

test.describe('home page', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, USER_B);
  });

  test('renders the Soundboard frame', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Soundboard');
    await expect(
      page.getByRole('banner').getByRole('link', { name: 'Soundboard', exact: true }),
    ).toHaveAttribute('href', '/');
    await expect(page.getByRole('contentinfo')).toContainText('Built for Flies Like Robots');
  });

  test('starts a new release on its own page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: START }).click();
    await expect(page).toHaveURL('/new');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pick the finished video');
    await expect(page.getByRole('form', { name: 'Start a release' })).toBeVisible();
  });
});

test.describe('new release', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, USER_B);
  });

  test('keeps Start disabled with no file picked', async ({ page }) => {
    await page.goto('/new');
    const start = page.getByRole('button', { name: 'Start the release' });
    await expect(start).toBeDisabled();
    await page.getByLabel("What's the song called?").fill('PeekaBoo');
    await expect(start).toBeDisabled();
    await expect(page.getByText('Any video file, up to 15 min')).toBeVisible();
  });

  test('fits the screen, with Start pinned in view on phones', async ({ page }, testInfo) => {
    await page.goto('/new');
    if (testInfo.project.name === 'mobile') {
      await expect(page.getByRole('button', { name: 'Start the release' })).toBeInViewport();
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

test.describe('releases', () => {
  test("puts the signed-in user's review up next and continues it", async ({ page }) => {
    await signIn(page, USER_B);
    await page.goto('/');
    const next = page.getByRole('region', { name: 'Review the draft for Vaporgram' });
    await expect(page.getByRole('region', { name: 'Earlier' })).toHaveCount(0);
    await next.getByRole('link', { name: 'Continue Vaporgram' }).click();
    await expect(page).toHaveURL('/jobs/e2e-b-review');
    await expect(page.getByLabel(/^Title/)).toHaveValue('Vaporgram');
  });

  test('sends a client navigation home once the session is gone', async ({ page }) => {
    await signIn(page, USER_B);
    await page.goto('/');
    const resume = page.getByRole('link', { name: 'Continue Vaporgram' });
    await expect(resume).toBeVisible();
    await page.context().clearCookies();
    await resume.click();
    await expect(page).toHaveURL('/');
    await expect(page.getByLabel(/^Title/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  });

  test('continues a release whose media expired, keeping its details', async ({ page }) => {
    await signIn(page, USER_A);
    await page.goto('/');
    // Every fixture shares a created time, so this review may be up next or under Earlier.
    await page.getByRole('link', { name: /^(Continue|Open) Gone Song$/ }).click();
    await expect(page).toHaveURL('/jobs/e2e-expired');
    await expect(page.getByRole('note')).toContainText('upload it again');
    await expect(page.getByLabel(/^Title/)).toHaveValue('PeekaBoo (Official Video)');
  });

  test("leaves another user's releases and every Short off the list", async ({ page }) => {
    await signIn(page, USER_A);
    await page.goto('/');
    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: /PeekaBoo$/ }).first()).toBeVisible();
    await expect(main).not.toContainText('Vaporgram');
    await expect(main.locator('a[href="/jobs/e2e-cut-short"]')).toHaveCount(0);
    await expect(main.locator('a[href="/jobs/e2e-cut"]')).toHaveCount(1);
  });
});

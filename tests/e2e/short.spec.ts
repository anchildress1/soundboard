import { expect, test, type Page } from '@playwright/test';
import { signIn, USER_A } from './session';

const TABS_JOB = '/jobs/e2e-tabs';

const tab = (page: Page, name: 'YouTube' | 'Short' | 'Bandcamp') =>
  page.getByRole('tab', { name: new RegExp(name) });
const shortPanel = (page: Page) => page.locator('#panel-short');

// Every job here is user A's, linked to FLR.
test.beforeEach(async ({ page }) => {
  await signIn(page, USER_A);
});

test.describe('destination tabs', () => {
  test('lists YouTube, Short, and Bandcamp, each to do, with YouTube open', async ({ page }) => {
    await page.goto(TABS_JOB);
    const tabs = page.getByRole('tablist', { name: 'Where it goes' }).getByRole('tab');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toContainText('YouTube');
    await expect(tabs.nth(1)).toContainText('Short');
    await expect(tabs.nth(2)).toContainText('Bandcamp');
    for (const t of await tabs.all()) await expect(t).toContainText('To do');
    await expect(tab(page, 'YouTube')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#panel-youtube')).toBeVisible();
    await expect(shortPanel(page)).toBeHidden();
  });

  test('moves between tabs from the keyboard', async ({ page }) => {
    await page.goto(TABS_JOB);
    // A key pressed before hydration attaches the tablist's handler does nothing, so retry it.
    await expect(async () => {
      await tab(page, 'YouTube').focus();
      await page.keyboard.press('ArrowRight');
      await expect(tab(page, 'Short')).toBeFocused({ timeout: 1000 });
    }).toPass();
    await expect(tab(page, 'Short')).toHaveAttribute('aria-selected', 'true');
    await expect(shortPanel(page)).toBeVisible();
    await page.keyboard.press('End');
    await expect(tab(page, 'Bandcamp')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'YouTube')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tab(page, 'Bandcamp')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tab(page, 'YouTube')).toBeFocused();
    await expect(page.locator('#panel-youtube')).toBeVisible();
  });

  test('keeps the tab row inside the screen', async ({ page }) => {
    // The load-in animation slides by fractions of a pixel; measure the settled layout.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(TABS_JOB);
    const width = page.viewportSize()!.width;
    for (const name of ['YouTube', 'Short', 'Bandcamp'] as const) {
      const box = (await tab(page, name).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });

  test('shows no tabs while the video is still being analyzed', async ({ page }) => {
    const step = page.waitForResponse((response) =>
      response.url().endsWith('/jobs/e2e-analyzing/step'),
    );
    await page.goto('/jobs/e2e-analyzing');
    expect(await (await step).json()).toMatchObject({
      wait: 'model busy',
      job: { state: 'ANALYZE', error: null },
    });
    await expect(page.getByText('model busy')).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
  });
});

test.describe('Short tab', () => {
  test('recovers an uncertain Short upload and discards only the Short', async ({
    page,
  }, testInfo) => {
    const id = `e2e-short-paused-${testInfo.project.name}`;
    await page.goto(`/jobs/${id}`);
    await tab(page, 'Short').click();
    const panel = shortPanel(page);
    const recovery = panel.getByRole('region', { name: 'Upload outcome unknown' });
    await expect(recovery).toBeVisible();
    await expect(
      recovery.getByRole('link', { name: 'Open YouTube Studio uploads' }),
    ).toHaveAttribute('href', /studio\.youtube\.com\/channel\/.+\/videos\/upload/);
    await expect(recovery.getByRole('button', { name: 'Confirm video' })).toBeDisabled();
    await recovery.getByLabel('Video link').fill('https://youtu.be/short-video');
    await expect(recovery.getByRole('button', { name: 'Confirm video' })).toBeEnabled();
    const discarded = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/api/jobs/${id}-short/discard`),
    );
    await panel.getByRole('button', { name: 'Discard' }).click();
    expect((await discarded).status()).toBe(200);
    await expect(panel.getByRole('button', { name: 'Make a Short' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/jobs/${id}$`));
    await tab(page, 'YouTube').click();
    await expect(page.getByRole('button', { name: 'Approve & upload' })).toBeEnabled();
  });

  test('makes a Short and waits on the model for the hook', async ({ page }, testInfo) => {
    await page.goto(`/jobs/e2e-make-${testInfo.project.name}`);
    await tab(page, 'Short').click();
    const step = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/step'),
    );
    await shortPanel(page).getByRole('button', { name: 'Make a Short' }).click();
    // The preload answers the hook pick with a 429 before any media call starts.
    expect(await (await step).json()).toMatchObject({
      wait: 'model busy',
      job: { state: 'HOOK', error: null },
    });
    await expect(shortPanel(page).getByRole('status')).toHaveText(/model busy/i);
    await expect(shortPanel(page).getByRole('heading', { name: 'YouTube Short' })).toBeVisible();
  });

  test('reviews a cut Short in a 9:16 frame with an accessible cut form', async ({ page }) => {
    await page.goto('/jobs/e2e-cut');
    await tab(page, 'Short').click();
    const panel = shortPanel(page);
    const monitor = (await panel.locator('.monitor').boundingBox())!;
    expect(monitor.width / monitor.height).toBeCloseTo(9 / 16, 2);
    await expect(panel.getByText('00:01:10 – 00:01:40 · 30s')).toBeVisible();
    await expect(panel.getByText('The chorus lands with the full band.')).toBeVisible();

    const start = panel.getByRole('spinbutton', { name: /^Start/ });
    const length = panel.getByRole('spinbutton', { name: /^Length/ });
    await expect(start).toHaveValue('70');
    await expect(length).toHaveValue('30');
    const recut = panel.getByRole('button', { name: 'Re-cut' });
    await expect(recut).toBeDisabled();

    await length.fill('75');
    await expect(length).toHaveAttribute('aria-invalid', 'true');
    await expect(length).toHaveAccessibleDescription('Length must be 15 to 60 seconds.');
    await expect(recut).toBeDisabled();
    await length.fill('30');

    const group = panel.getByRole('group', { name: 'Fit to 9:16' });
    await expect(group.getByRole('radio', { name: 'Blur fill' })).toBeChecked();
    await group.getByRole('radio', { name: 'Center crop' }).check();
    await expect(recut).toBeEnabled();

    await expect(panel.getByRole('button', { name: 'Re-pick hook' })).toBeEnabled();
    await expect(panel.getByLabel(/^Title/)).toHaveValue('PeekaBoo (Official Video)');
  });

  test("sends a Short's own URL to its video's page", async ({ page }) => {
    await page.goto('/jobs/e2e-cut-short');
    await expect(page).toHaveURL(/\/jobs\/e2e-cut$/);
  });
});

import { expect, test, type Page } from '@playwright/test';

const tab = (page: Page, name: 'YouTube' | 'Short' | 'Bandcamp') =>
  page.getByRole('tab', { name: new RegExp(name) });
const shortPanel = (page: Page) => page.locator('#panel-short');

test.describe('destination tabs', () => {
  test('lists YouTube, Short, and Bandcamp, each to do, with YouTube open', async ({ page }) => {
    await page.goto('/jobs/e2e-tabs');
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
    await page.goto('/jobs/e2e-tabs');
    await tab(page, 'YouTube').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Short')).toBeFocused();
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
    await page.goto('/jobs/e2e-tabs');
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
    await page.goto('/jobs/e2e-analyzing');
    await expect(page.getByText('waking model')).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
  });
});

test.describe('Short tab', () => {
  test('makes a Short and waits on the model for the hook', async ({ page }, testInfo) => {
    await page.goto(`/jobs/e2e-make-${testInfo.project.name}`);
    await tab(page, 'Short').click();
    await shortPanel(page).getByRole('button', { name: 'Make a Short' }).click();
    // No llama-server runs in E2E, so the hook step reports the model as loading.
    await expect(shortPanel(page).getByRole('status')).toHaveText(/waking model/i);
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

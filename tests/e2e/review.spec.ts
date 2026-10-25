import { expect, test, type Page } from '@playwright/test';
import { signIn, USER_A, USER_B } from './session';

// Read-only: nothing here approves, so both projects share user A's review job.
const JOB = '/jobs/e2e-tabs';

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
// A fill before hydration lands in the server-rendered input and is lost; clearing the title
// disables Next only once hydration has attached the handlers.
const clearTitleOnceHydrated = (page: Page) =>
  expect(async () => {
    await page.getByLabel(/^Title/).fill('');
    await expect(button(page, 'Keep it, next')).toBeDisabled({ timeout: 1000 });
  }).toPass();

test('walks the draft one field at a time to approval', async ({ page }) => {
  await signIn(page, USER_A);
  await page.goto(JOB);
  await expect(h1(page)).toHaveText('Does this title work?');
  await expect(page.getByLabel(/^Title/)).toHaveValue('PeekaBoo (Official Video)');
  await expect(page.getByText('Matches the genre.')).toBeVisible();
  await button(page, 'Keep it, next').click();

  await expect(h1(page)).toHaveText('Read the description');
  await expect(page.getByLabel(/^Description/)).toHaveValue(/Night drive in a borrowed car\./);
  await button(page, 'Looks right, next').click();

  await expect(h1(page)).toHaveText('Check the tags');
  await expect(page.getByLabel(/^Tags/)).toHaveValue('synthwave, Flies Like Robots');
  // No ffmpeg flags on this pick, so the check screen is skipped.
  await button(page, 'Fine, next').click();

  await expect(h1(page)).toHaveText('Ready to upload');
  const facts = page.getByRole('main').locator('dl');
  await expect(facts).toContainText('Flies Like Robots');
  await expect(facts).toContainText('Private');
  await expect(button(page, 'Approve & upload')).toBeEnabled();
  await button(page, 'Back').click();
  await expect(h1(page)).toHaveText('Check the tags');
});

test('blocks the next step on an invalid field', async ({ page }) => {
  await signIn(page, USER_A);
  await page.goto(JOB);
  await clearTitleOnceHydrated(page);
});

test('keeps edits and the step across a reload', async ({ page }) => {
  await signIn(page, USER_A);
  await page.goto(JOB);
  await clearTitleOnceHydrated(page);
  await page.getByLabel(/^Title/).fill('PeekaBoo (Live)');
  await button(page, 'Keep it, next').click();
  await expect(h1(page)).toHaveText('Read the description');
  await page.reload();
  await expect(h1(page)).toHaveText('Read the description');
  await button(page, 'Back').click();
  await expect(page.getByLabel(/^Title/)).toHaveValue('PeekaBoo (Live)');
});

test('sends a user with no YouTube connection to reconnect instead of approving', async ({
  page,
}) => {
  await signIn(page, USER_B);
  await page.goto('/jobs/e2e-b-review');
  await button(page, 'Keep it, next').click();
  await button(page, 'Looks right, next').click();
  await button(page, 'Fine, next').click();
  await expect(h1(page)).toHaveText('Ready to upload');
  await expect(button(page, 'Approve & upload')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Reconnect YouTube' })).toHaveAttribute(
    'href',
    '/connections',
  );
});

test('keeps the primary action in reach', async ({ page }, testInfo) => {
  await signIn(page, USER_A);
  await page.goto(JOB);
  await button(page, 'Keep it, next').click();
  const primary = button(page, 'Looks right, next');
  await expect(primary).toBeInViewport();
  if (testInfo.project.name === 'mobile') {
    // Phones pin the actions to the bottom with the primary across the full width.
    const box = (await primary.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.width).toBeGreaterThanOrEqual(viewport.width - 2 * 16 - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

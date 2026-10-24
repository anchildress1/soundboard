import { expect, test, type Page } from '@playwright/test';
import { BROKEN_STATUSES } from './fakes/fixtures';
import { signIn, USER_A, USER_B } from './session';

const FIXES = {
  missing_scopes: 'Upload and read access are missing. Reconnect and allow both.',
  no_channel: 'This Google account has no YouTube channel. Create one, then reconnect.',
  revoked: 'Access was removed. Reconnect to keep uploading.',
} satisfies Record<(typeof BROKEN_STATUSES)[number], string>;

const youtube = (page: Page) => page.getByRole('region', { name: 'YouTube' });

test('the header links Connections, which shows the connected channel', async ({ page }) => {
  await signIn(page, USER_A);
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('banner').getByRole('link', { name: 'Connections' }).click();
  await expect(page).toHaveURL('/connections');
  await expect(youtube(page)).toContainText('Connected to Flies Like Robots.');
  await expect(youtube(page).getByRole('button', { name: 'Disconnect' })).toBeEnabled();
});

for (const status of BROKEN_STATUSES) {
  test(`shows ${status} with its fix line and Reconnect`, async ({ page }) => {
    await signIn(page, `uid-${status}`);
    await page.goto('/connections');
    await expect(youtube(page)).toContainText(FIXES[status]);
    await expect(youtube(page).getByRole('button', { name: 'Reconnect' })).toBeVisible();
    await expect(youtube(page).getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
  });
}

test('offers Connect to a user who never connected', async ({ page }) => {
  await signIn(page, USER_B);
  await page.goto('/connections');
  await expect(youtube(page)).toContainText('Not connected.');
  await expect(youtube(page).getByRole('button', { name: 'Connect' })).toBeVisible();
});

test('explains a callback outcome', async ({ page }) => {
  await signIn(page, USER_A);
  await page.goto('/connections?connect=wrong-account');
  await expect(page.getByRole('status').filter({ hasText: 'Google account' })).toHaveText(
    'Connect YouTube with the Google account you signed in with.',
  );
});

test('a paused upload links YouTube Studio and can be discarded', async ({ page }, testInfo) => {
  await signIn(page, USER_A);
  await page.goto(`/jobs/e2e-paused-${testInfo.project.name}`);
  const paused = page.getByRole('region', { name: 'Upload outcome unknown' });
  await expect(paused.getByRole('link', { name: 'Open YouTube Studio uploads' })).toHaveAttribute(
    'href',
    'https://studio.youtube.com/channel/UCflr/videos/upload',
  );
  await expect(paused.getByLabel('Video link')).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL('/');
  const response = await page.request.get(`/api/jobs/e2e-paused-${testInfo.project.name}`);
  expect(((await response.json()) as { job: { state: string } }).job.state).toBe('DISCARDED');
});

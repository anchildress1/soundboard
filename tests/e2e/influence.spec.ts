import { expect, test, type Page } from '@playwright/test';
import { researchUser, signIn, slidersUser } from './session';

const save = (page: Page) => page.getByRole('button', { name: 'Save settings', exact: true });
const sound = (page: Page) => page.locator('#influence-sound');

test('saves the sliders on the approved brand guide and keeps them after a reload', async ({
  page,
}, testInfo) => {
  await signIn(page, slidersUser(testInfo));
  await page.goto('/settings');
  await expect(save(page)).toBeEnabled();
  await expect(sound(page)).toHaveValue('1');
  await expect(page.locator('#influence-discovery')).toHaveValue('4');
  // A change before hydration is lost with the native submit, so each try sets it again.
  await expect(async () => {
    await sound(page).fill('3');
    await save(page).click();
    await expect(page.getByText('Saved. Applies to later drafts.')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });

  await page.reload();
  await expect(sound(page)).toHaveValue('3');
});

test('shows the defaults and disables Save until a brand guide is approved', async ({
  page,
}, testInfo) => {
  await signIn(page, researchUser(testInfo));
  await page.goto('/settings');
  await expect(save(page)).toBeDisabled();
  await expect(
    page.getByText(/Approve your brand guide to save your own settings\./),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Brand' })).toHaveAttribute('href', '/brand');
  await expect(sound(page)).toHaveValue('1');
  await expect(page.locator('#influence-structure')).toHaveValue('4');
});

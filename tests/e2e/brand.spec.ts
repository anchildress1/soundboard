import { expect, test, type Page } from '@playwright/test';
import { NATHAN_BRAND } from './fakes/fixtures';
import { brandUser, proposeUser, raceUser, signIn, USER_A, USER_B, USER_C } from './session';

const NOT_SET_VOICE = 'Not set. Drafts use plain, generic rules.';
const NOT_SET_BRAND = 'Not set. Drafts run without one.';
const voice = (page: Page) => page.getByRole('region', { name: 'Voice' });
const brand = (page: Page) => page.getByRole('region', { name: 'Brand guide' });
const proposed = (page: Page, kind: 'voice' | 'brand') => () =>
  page.waitForResponse((response) => response.url().endsWith(`/api/guides/${kind}/propose`));

test.describe('brand page', () => {
  test('sends a signed-out user home and refuses its API', async ({ page, request, baseURL }) => {
    const response = await request.get('/brand', { maxRedirects: 0 });
    expect([response.status(), response.headers().location]).toEqual([303, '/']);
    // A browser sends Origin on every POST; SvelteKit refuses a bodyless POST without one.
    const sameOrigin = { headers: { origin: baseURL! } };
    for (const kind of ['voice', 'brand']) {
      expect((await request.post(`/api/guides/${kind}/propose`, sameOrigin)).status()).toBe(401);
    }
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Brand' })).toHaveCount(0);
  });

  test('is a 404 for a user without a profile', async ({ page, baseURL }) => {
    await signIn(page, USER_B);
    expect((await page.goto('/brand'))?.status()).toBe(404);
    const sameOrigin = { headers: { origin: baseURL! } };
    expect((await page.request.post('/api/guides/voice/propose', sameOrigin)).status()).toBe(404);
    await page.goto('/');
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.getByRole('link', { name: 'Brand' })).toHaveCount(0);
  });

  test("opens from the menu for any profile, with neither guide set and none of Nathan's", async ({
    page,
  }) => {
    await signIn(page, USER_C);
    await page.goto('/');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('link', { name: 'Brand' }).click();
    await expect(page).toHaveURL('/brand');
    await expect(voice(page).getByText(NOT_SET_VOICE)).toBeVisible();
    await expect(brand(page).getByText(NOT_SET_BRAND)).toBeVisible();
    await expect(page.getByText(NATHAN_BRAND.statement)).toHaveCount(0);
    await expect(page.getByText('Short, plain, literal.')).toHaveCount(0);
  });

  for (const kind of ['voice', 'brand'] as const) {
    test(`waits on a busy model for a ${kind} proposal and keeps asking, storing none`, async ({
      page,
    }, testInfo) => {
      await signIn(page, proposeUser(testInfo));
      await page.goto('/brand');
      const section = kind === 'voice' ? voice(page) : brand(page);
      const next = proposed(page, kind);
      const first = next();
      await section.getByRole('button', { name: 'Propose' }).click();
      // The preload answers the model call with a 429 after the upload reads.
      expect(await (await first).json()).toEqual({ wait: 'model busy' });
      await expect(section.getByRole('button', { name: 'Model busy' })).toBeDisabled();
      expect(await (await next()).json()).toEqual({ wait: 'model busy' });
      await page.reload();
      await expect(section.getByRole('form')).toHaveCount(0);
    });
  }

  test("shows Nathan's carried-over voice and his brand guide", async ({ page }) => {
    await signIn(page, USER_A);
    await page.goto('/brand');
    await expect(voice(page).getByText('Carried over from your earlier rules')).toBeVisible();
    await expect(voice(page).getByText('Short, plain, literal.')).toBeVisible();
    await expect(voice(page).getByText(/hacked and slashed/)).toBeVisible();
    await expect(brand(page).getByText(NATHAN_BRAND.statement)).toBeVisible();
    await expect(brand(page).getByText('Carried over from your earlier guide')).toBeVisible();
  });

  test('approves an edited voice proposal and keeps it on reload', async ({ page }, testInfo) => {
    await signIn(page, brandUser(testInfo));
    await page.goto('/brand');
    const form = voice(page).getByRole('form', { name: 'Proposed voice' });
    await form.getByLabel(/^Rules/).fill('Short, dry sentences.\nNo exclamation marks.');
    await form.getByRole('button', { name: 'Approve' }).click();
    await expect(voice(page).getByText('No exclamation marks.')).toBeVisible();
    await expect(
      voice(page).getByText(/From 0 uploads,\s+0 Soundboard drafts,\s+2 edits and 1 approval,/),
    ).toBeVisible();
    await page.reload();
    await expect(voice(page).getByText('No exclamation marks.')).toBeVisible();
    await expect(voice(page).getByRole('form')).toHaveCount(0);
  });

  test('refuses a stale approval from a second tab and keeps its edit', async ({
    page,
    context,
  }, testInfo) => {
    await signIn(page, raceUser(testInfo));
    const second = await context.newPage();
    await page.goto('/brand');
    await second.goto('/brand');
    const rules = (tab: Page) => voice(tab).getByLabel(/^Rules/);
    await rules(page).fill('First tab rule.');
    await voice(page).getByRole('button', { name: 'Approve' }).click();
    await expect(voice(page).getByText('First tab rule.')).toBeVisible();

    await rules(second).fill('Second tab rule.');
    await voice(second).getByRole('button', { name: 'Approve' }).click();
    await expect(
      voice(second).getByText('The guide changed in another tab. Reload to see it.'),
    ).toBeVisible();
    await expect(rules(second)).toHaveValue('Second tab rule.');
    await second.reload();
    await expect(voice(second).getByText('First tab rule.')).toBeVisible();
  });
});

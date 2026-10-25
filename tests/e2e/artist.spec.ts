import { expect, test, type Locator, type Page } from '@playwright/test';
import { newUser, renameUser, signIn, USER_A, USER_B, USER_C } from './session';

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const field = (page: Page, label: RegExp) => page.getByLabel(label);
const NAME = /^Artist name/;
const BANDCAMP = /^Bandcamp URL/;
const CONTACT = /^Contact line/;
const FLR = ['Flies Like Robots', 'flieslikerobots'];
const nameError = (page: Page, text: string) => page.locator('#artist-name-msg', { hasText: text });

/**
 * Fills the form and saves until `shown` appears. A save before hydration submits the
 * server-rendered form natively, which only reloads the page, so each try refills.
 */
async function save(page: Page, fields: [RegExp, string][], submit: string, shown: Locator) {
  await expect(async () => {
    for (const [label, value] of fields) await field(page, label).fill(value);
    await button(page, submit).click();
    await expect(shown).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
}

async function expectNoFlr(page: Page) {
  const html = await page.content();
  for (const value of FLR) expect(html).not.toContain(value);
}

test.describe('first run', () => {
  test('asks for the artist before the first release, then opens the release form', async ({
    page,
  }, testInfo) => {
    await signIn(page, newUser(testInfo));
    await page.goto('/new');
    await expect(h1(page)).toHaveText("Who's the artist?");

    const sameOrigin = { headers: { origin: new URL(page.url()).origin } };
    const early = await page.request.post('/api/jobs', { ...sameOrigin, data: {} });
    expect([early.status(), (await early.json()).error]).toEqual([
      409,
      'Add your artist name first.',
    ]);

    await save(page, [[NAME, '']], 'Save', nameError(page, 'Add the artist name.'));
    await page.reload();
    await expect(h1(page)).toHaveText("Who's the artist?");

    await save(page, [[NAME, 'B Band']], 'Save', h1(page).getByText('Pick the finished video'));
    await expect(page.getByRole('banner')).toContainText('B Band');
  });

  test('shows Nathan the release form directly', async ({ page }) => {
    await signIn(page, USER_A);
    await page.goto('/new');
    await expect(h1(page)).toHaveText('Pick the finished video');
  });

  test('still opens a job made before any profile', async ({ page }) => {
    await signIn(page, USER_B);
    await page.goto('/jobs/e2e-b-review');
    await expect(h1(page)).toHaveText('Does this title work?');
  });
});

test.describe("another artist's drafts", () => {
  test('keeps the fixed artist tag when the comma field is cleared', async ({ page }, testInfo) => {
    await signIn(page, USER_C);
    // The approval is the check; the upload steps after it would leave the fakes.
    await page.route('**/step', (route) => route.abort());
    await page.goto(`/jobs/e2e-c-review-${testInfo.project.name}`);
    await expect(h1(page)).toHaveText('Does this title work?');
    await button(page, 'Keep it, next').click();
    await button(page, 'Looks right, next').click();

    await expect(h1(page)).toHaveText('Check the tags');
    await expect(page.locator('.fixed-tag')).toHaveText(/Test Artist/);
    await expect(page.getByLabel(/^Tags/)).toHaveValue('synthwave');
    await page.getByLabel(/^Tags/).fill('');
    await button(page, 'Fine, next').click();

    await expect(h1(page)).toHaveText('Ready to upload');
    const approval = page.waitForResponse((response) => response.url().endsWith('/approve'));
    await button(page, 'Approve & upload').click();
    const response = await approval;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON().tags).toEqual(['Test Artist']);
  });
});

test.describe("the user's artist on screen", () => {
  test("names C's artist and Bandcamp page, never Nathan's", async ({ page }) => {
    await signIn(page, USER_C);
    await page.goto('/');
    await expect(page.getByRole('banner')).toContainText('Test Artist');
    const footer = page.getByRole('contentinfo');
    await expect(footer.getByRole('link', { name: 'Test Artist' })).toHaveAttribute(
      'href',
      'https://test-artist.bandcamp.com',
    );
    await expectNoFlr(page);

    await page.goto('/jobs/e2e-c-done');
    await page
      .getByRole('region', { name: 'Up next, if you want' })
      .getByRole('button', { name: /Put it on Bandcamp/ })
      .click();
    await expect(
      page.getByRole('link', { name: "Open Bandcamp's new-track page" }),
    ).toHaveAttribute('href', 'https://test-artist.bandcamp.com/edit_track');
    await expectNoFlr(page);

    await page.goto('/settings');
    await expectNoFlr(page);
  });

  for (const path of ['/', '/privacy', '/terms']) {
    test(`names no artist signed out on ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('contentinfo')).not.toContainText('Built for');
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        'content',
        'Release agent for musicians: Gemini watches and listens to a music video, then drafts and verifies the YouTube upload.',
      );
      await expectNoFlr(page);
    });
  }
});

test.describe('settings', () => {
  test('edits the artist details, refusing invalid ones', async ({ page }, testInfo) => {
    await signIn(page, renameUser(testInfo));
    await page.goto('/settings');
    await expect(field(page, NAME)).toHaveValue('Rename Band');
    await expect(field(page, BANDCAMP)).toHaveValue('https://rename-band.bandcamp.com');
    await expect(field(page, CONTACT)).toHaveValue('Booking: rename@example.com');

    await save(page, [[NAME, '']], 'Save changes', nameError(page, 'Add the artist name.'));
    await page.reload();
    await expect(field(page, NAME)).toHaveValue('Rename Band');

    await save(
      page,
      [[BANDCAMP, 'http://x']],
      'Save changes',
      page.locator('#artist-bandcamp-msg', {
        hasText: 'Use your https://<name>.bandcamp.com address.',
      }),
    );
    await save(
      page,
      [
        [NAME, 'A, B'],
        [BANDCAMP, 'https://rename-band.bandcamp.com'],
      ],
      'Save changes',
      nameError(page, "Artist names can't contain commas."),
    );
    await save(page, [[NAME, 'Renamed Band']], 'Save changes', page.getByText('Saved.'));
    await expect(page.getByRole('banner')).toContainText('Renamed Band');

    await page.reload();
    await expect(field(page, NAME)).toHaveValue('Renamed Band');
    await expect(field(page, BANDCAMP)).toHaveValue('https://rename-band.bandcamp.com');
    await expect(field(page, CONTACT)).toHaveValue('Booking: rename@example.com');
  });
});

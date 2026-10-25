import { expect, test, type Page } from '@playwright/test';
import { signIn, USER_A } from './session';

const REVIEW_JOB = '/jobs/e2e-tabs';

const offers = (page: Page) => page.getByRole('region', { name: 'Up next, if you want' });
const theShort = (page: Page) => page.getByRole('region', { name: 'The Short' });

// Every job here is user A's, linked to FLR. Shorts hang off releases already on YouTube.
test.beforeEach(async ({ page }) => {
  await signIn(page, USER_A);
});

test.describe('up next', () => {
  test('offers nothing until the release is approved', async ({ page }) => {
    await page.goto(REVIEW_JOB);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Does this title work?');
    await expect(offers(page)).toHaveCount(0);
  });

  test('offers a Short and Bandcamp once the release is up', async ({ page }, testInfo) => {
    await page.goto(`/jobs/e2e-make-${testInfo.project.name}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("It's on your channel");
    await expect(offers(page).getByRole('button', { name: /Make a Short/ })).toBeEnabled();
    await expect(offers(page).getByRole('button', { name: /Put it on Bandcamp/ })).toBeEnabled();
    await expect(offers(page).getByRole('link', { name: "I'm done for now" })).toHaveAttribute(
      'href',
      '/',
    );
  });

  test('keeps the offers inside the screen', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/jobs/e2e-make-${testInfo.project.name}`);
    const width = page.viewportSize()!.width;
    for (const offer of await offers(page).getByRole('button').all()) {
      const box = (await offer.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });

  test('opens Bandcamp as a side trip and comes back', async ({ page }, testInfo) => {
    await page.goto(`/jobs/e2e-make-${testInfo.project.name}`);
    await offers(page)
      .getByRole('button', { name: /Put it on Bandcamp/ })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Copy these into Bandcamp');
    await page.getByRole('button', { name: 'Back to the release' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("It's on your channel");
  });

  test('holds an offer until the page can act on it', async ({ page }, testInfo) => {
    // Slow script delivery stands in for a loaded phone: the server-rendered offer shows first.
    await page.route('**/_app/immutable/**', async (route) => {
      await new Promise((done) => setTimeout(done, 2000));
      await route.continue();
    });
    await page.goto(`/jobs/e2e-make-${testInfo.project.name}`, { waitUntil: 'commit' });
    const bandcamp = offers(page).getByRole('button', { name: /Put it on Bandcamp/ });
    await expect(bandcamp).toBeDisabled();
    await bandcamp.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Copy these into Bandcamp');
  });

  test('shows no offers while the video is still being analyzed', async ({ page }) => {
    const step = page.waitForResponse((response) =>
      response.url().endsWith('/jobs/e2e-analyzing/step'),
    );
    await page.goto('/jobs/e2e-analyzing');
    expect(await (await step).json()).toMatchObject({
      wait: 'model busy',
      job: { state: 'ANALYZE', error: null },
    });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Model busy');
    await expect(offers(page)).toHaveCount(0);
  });
});

test.describe('the Short', () => {
  test('recovers an uncertain Short upload and discards only the Short', async ({
    page,
  }, testInfo) => {
    const id = `e2e-short-paused-${testInfo.project.name}`;
    await page.goto(`/jobs/${id}`);
    await offers(page)
      .getByRole('button', { name: /Finish the Short/ })
      .click();
    const main = page.getByRole('main');
    const recovery = main.getByRole('region', { name: 'Upload outcome unknown' });
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
    await main.getByRole('button', { name: 'Discard', exact: true }).click();
    expect((await discarded).status()).toBe(200);
    await expect(offers(page).getByRole('button', { name: /Make a Short/ })).toBeVisible();
    await expect(page).toHaveURL(`/jobs/${id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("It's on your channel");
  });

  test('makes a Short and waits on the model for the hook', async ({ page }, testInfo) => {
    await page.goto(`/jobs/e2e-make-${testInfo.project.name}`);
    const step = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/step'),
    );
    await offers(page)
      .getByRole('button', { name: /Make a Short/ })
      .click();
    // The preload answers the hook pick with a 429 before any media call starts.
    expect(await (await step).json()).toMatchObject({
      wait: 'model busy',
      job: { state: 'HOOK', error: null },
    });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Is this the hook?');
    await expect(theShort(page).getByRole('status')).toHaveText('Model busy');
    await expect(page.getByRole('heading', { name: 'YouTube Short' })).toBeVisible();
  });

  test('refuses a Short of a video analyzed by an older version', async ({ page }) => {
    await page.goto('/jobs/e2e-stale');
    const make = page.waitForResponse((response) => response.url().endsWith('/short'));
    await offers(page)
      .getByRole('button', { name: /Make a Short/ })
      .click();
    expect((await make).status()).toBe(409);
    await expect(
      offers(page).getByText(
        'This video was analyzed by an older version. Upload it again to make a Short.',
      ),
    ).toBeVisible();
    await expect(offers(page).getByRole('button', { name: /Make a Short/ })).toBeEnabled();
  });

  test('reviews a cut Short in a 9:16 frame with an accessible cut form', async ({ page }) => {
    await page.goto('/jobs/e2e-cut');
    await offers(page)
      .getByRole('button', { name: /Finish the Short/ })
      .click();
    const short = theShort(page);
    const monitor = (await short.locator('.monitor').boundingBox())!;
    expect(monitor.width / monitor.height).toBeCloseTo(9 / 16, 2);
    await expect(short.getByText('00:01:10 – 00:01:40 · 30s')).toBeVisible();
    await expect(short.getByText('The chorus lands with the full band.')).toBeVisible();

    const start = short.getByRole('spinbutton', { name: /^Start/ });
    const length = short.getByRole('spinbutton', { name: /^Length/ });
    await expect(start).toHaveValue('70');
    await expect(length).toHaveValue('30');
    const recut = short.getByRole('button', { name: 'Re-cut' });
    await expect(recut).toBeDisabled();

    await length.fill('75');
    await expect(length).toHaveAttribute('aria-invalid', 'true');
    await expect(length).toHaveAccessibleDescription('Length must be 15 to 60 seconds.');
    await expect(recut).toBeDisabled();
    await length.fill('30');

    const group = short.getByRole('group', { name: 'Fit to 9:16' });
    await expect(group.getByRole('radio', { name: 'Blur fill' })).toBeChecked();
    await group.getByRole('radio', { name: 'Center crop' }).check();
    await expect(recut).toBeEnabled();

    const main = page.getByRole('main');
    await expect(main.getByRole('button', { name: 'Re-pick hook' })).toBeEnabled();
    await expect(main.getByLabel(/^Title/)).toHaveValue('PeekaBoo (Official Video)');
  });

  test("sends a Short's own URL to its video's page", async ({ page }) => {
    await page.goto('/jobs/e2e-cut-short');
    await expect(page).toHaveURL(/\/jobs\/e2e-cut$/);
  });
});

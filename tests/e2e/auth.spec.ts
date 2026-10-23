import { expect, test } from '@playwright/test';
import { sessionCookie, signIn, USER_A, USER_B } from './session';

test.describe('signed out', () => {
  test('opens the privacy policy from the footer without signing in', async ({ page, context }) => {
    await page.goto('/');
    const footer = page.getByRole('contentinfo');
    await expect(footer).toContainText('Ashley Childress');
    await expect(footer).not.toContainText('Hacktoberfest');
    await footer.getByRole('link', { name: 'Privacy policy' }).click();
    await expect(page).toHaveURL('/privacy');
    await expect(page).toHaveTitle('Privacy policy · Soundboard');
    await expect(page.getByRole('heading', { name: 'Privacy policy', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Google Privacy Policy' })).toHaveAttribute(
      'href',
      'https://policies.google.com/privacy',
    );
    expect(await context.cookies()).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
  });

  test('serves the privacy policy directly without a redirect', async ({ request }) => {
    const response = await request.get('/privacy', { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('Storage and deletion');
    expect(response.headers()['set-cookie']).toBeUndefined();
  });

  test('shows only the sign-in view and sets zero cookies', async ({ page, context }) => {
    const response = await page.goto('/');
    expect(response?.headers()['set-cookie']).toBeUndefined();
    await expect(
      page.getByRole('banner').getByRole('link', { name: 'Sign in with Google' }),
    ).toBeVisible();
    await expect(page.getByRole('form', { name: 'Start a run' })).toHaveCount(0);
    await page.waitForLoadState('load');
    expect(await context.cookies()).toEqual([]);
  });

  for (const path of ['/jobs/x', '/brand', '/connections']) {
    test(`redirects ${path} home`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL('/');
      await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
    });
  }

  test("answers a client navigation's data request with a redirect through /auth/signed-out", async ({
    request,
  }) => {
    const response = await request.get('/jobs/e2e-b-review/__data.json', { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ type: 'redirect', location: '/auth/signed-out' });
  });

  test('refuses POST /api/jobs with 401', async ({ request }) => {
    const response = await request.post('/api/jobs', { data: { songTitle: 'PeekaBoo' } });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ message: 'Sign in first.' });
  });

  test('says why an uninvited account was turned away', async ({ page }) => {
    await page.goto('/?signin=denied');
    await expect(page.getByRole('status')).toHaveText("That Google account isn't invited.");
  });

  test('lets only the app frame its pages', async ({ request }) => {
    const response = await request.get('/', { maxRedirects: 0 });
    expect(response.headers()['content-security-policy']).toBe("frame-ancestors 'self'");
  });
});

test('a signed-in user gets the upload form, not sign-in', async ({ page }) => {
  await signIn(page, USER_B);
  await page.goto('/');
  await expect(page.getByRole('form', { name: 'Start a run' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toHaveCount(0);
});

test('a session that stops validating mid-run sends the job page home', async ({
  page,
}, testInfo) => {
  await signIn(page, USER_A);
  const job = `/jobs/e2e-signout-${testInfo.project.name}`;
  const first = page.waitForResponse((r) => r.url().endsWith(`${job}/step`));
  await page.goto(job);
  expect((await first).status()).toBe(200);
  // Validly signed, but for a uid with no active user row, as after a deactivation.
  await page
    .context()
    .addCookies([
      { name: 'sb_session', value: sessionCookie('uid-gone'), url: 'http://localhost:4173' },
    ]);
  const refused = await page.waitForResponse((r) => r.url().endsWith(`${job}/step`));
  expect(refused.status()).toBe(401);
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
});

test('a client navigation home after the session ends drops the signed-in layout', async ({
  page,
}) => {
  await signIn(page, USER_B);
  await page.goto('/jobs/e2e-b-review');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.context().clearCookies();
  await page.getByRole('link', { name: 'Soundboard' }).click();
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Start a run' })).toHaveCount(0);
});

test('opens privacy after a session ends without retaining signed-in controls', async ({
  page,
}) => {
  await signIn(page, USER_B);
  await page.goto('/');
  await page.context().clearCookies();
  await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy policy' }).click();
  await expect(page).toHaveURL('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy policy', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
});

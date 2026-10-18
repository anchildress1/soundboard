import { expect, test } from '@playwright/test';
import { sessionCookie, signIn, USER_A, USER_B } from './session';

test.describe('signed out', () => {
  test('shows only the sign-in view and sets zero cookies', async ({ page, context }) => {
    const response = await page.goto('/');
    expect(response?.headers()['set-cookie']).toBeUndefined();
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
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
  // A cookie from an older access generation, as after a revoke: present, but no longer valid.
  await page
    .context()
    .addCookies([
      { name: 'sb_session', value: sessionCookie(USER_A, 0), url: 'http://localhost:4173' },
    ]);
  const refused = await page.waitForResponse((r) => r.url().endsWith(`${job}/step`));
  expect(refused.status()).toBe(401);
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
});

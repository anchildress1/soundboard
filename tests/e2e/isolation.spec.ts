import { expect, test, type Browser, type Page } from '@playwright/test';
import { signIn, USER_A, USER_B } from './session';

const A_JOB = '/jobs/e2e-tabs';
const B_JOB = '/jobs/e2e-b-review';

async function signedIn(browser: Browser, uid: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, uid);
  return { context, page };
}

const signOut = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
};

test.describe('two users', () => {
  test("each opens only their own job and gets 404 on the other's", async ({
    browser,
    baseURL,
  }) => {
    const a = await signedIn(browser, USER_A);
    const b = await signedIn(browser, USER_B);
    expect((await a.page.goto(A_JOB))?.status()).toBe(200);
    expect((await b.page.goto(B_JOB))?.status()).toBe(200);
    expect((await a.page.goto(B_JOB))?.status()).toBe(404);
    expect((await b.page.goto(A_JOB))?.status()).toBe(404);
    expect((await a.page.request.get('/api/jobs/e2e-b-review')).status()).toBe(404);
    // A browser sends Origin on every POST; SvelteKit refuses a bodyless POST without one.
    const step = await b.page.request.post('/api/jobs/e2e-tabs/step', {
      headers: { origin: baseURL! },
    });
    expect(step.status()).toBe(404);
    await a.context.close();
    await b.context.close();
  });

  test('signing A out leaves B signed in', async ({ browser }) => {
    const a = await signedIn(browser, USER_A);
    const b = await signedIn(browser, USER_B);
    await signOut(a.page);
    await b.page.goto('/');
    await expect(b.page.getByRole('form', { name: 'Start a run' })).toBeVisible();
    await a.context.close();
    await b.context.close();
  });
});

test('one user in two browsers: signing out one leaves the other signed in', async ({
  browser,
}) => {
  const first = await signedIn(browser, USER_B);
  const second = await signedIn(browser, USER_B);
  await signOut(first.page);
  expect((await second.page.goto(B_JOB))?.status()).toBe(200);
  await expect(second.page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await first.context.close();
  await second.context.close();
});

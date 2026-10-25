import { expect, test, type Page } from '@playwright/test';
import { researchUser, signIn, USER_A, USER_C } from './session';

const noHorizontalScroll = async (page: Page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0);

test('analyzes the next window up to the model, then waits while it is busy', async ({
  page,
}, testInfo) => {
  await signIn(page, USER_A);
  const id = `e2e-analyze-${testInfo.project.name}`;
  const step = page.waitForResponse((response) => response.url().endsWith(`/jobs/${id}/step`));
  await page.goto(`/jobs/${id}`);
  // The faked window cut and measurement ran; the preload's 429 is the model call's answer.
  expect(await (await step).json()).toMatchObject({
    wait: 'model busy',
    job: { state: 'ANALYZE', chunkIndex: 1, error: null },
    chunks: [{ index: 0 }],
  });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Model busy');
  await expect(page.getByText('Configured analyst: gemini-3.8-flash')).toBeVisible();
  await noHorizontalScroll(page);
});

test('waits on research, then while the model is busy during the pick', async ({
  page,
}, testInfo) => {
  await signIn(page, USER_C);
  const id = `e2e-pick-${testInfo.project.name}`;
  const steps: unknown[] = [];
  page.on('response', async (response) => {
    if (response.url().endsWith(`/jobs/${id}/step`)) steps.push(await response.json());
  });
  await page.goto(`/jobs/${id}`);
  // The first step starts research and waits; the queue fake finishes it, so the next poll picks.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Researching similar artists');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Model busy');
  expect(steps.slice(0, 2)).toMatchObject([
    { wait: 'researching similar artists', job: { state: 'PICK', error: null } },
    { wait: 'model busy', job: { state: 'PICK', error: null } },
  ]);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Model busy');
  await expect(page.getByText('Configured picker: gemini-4-argon')).toBeVisible();
  await noHorizontalScroll(page);
});

test('approves a researched draft with the same four clicks and nothing to fill in', async ({
  page,
}, testInfo) => {
  await signIn(page, researchUser(testInfo));
  // The approval is the check; the upload steps after it would leave the fakes.
  await page.route('**/step', (route) => route.abort());
  await page.goto(`/jobs/e2e-research-approve-${testInfo.project.name}`);
  const clicks = ['Keep it, next', 'Looks right, next', 'Fine, next'];
  for (const name of clicks) await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ready to upload');
  // The recommendation, peers and results are there to read, and none of them asks for input.
  await expect(page.getByRole('region', { name: 'Recommendation' })).toBeVisible();
  await expect(page.getByText(/^Similar artists \(3\)$/)).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Recommendation' }).getByRole('textbox'),
  ).toHaveCount(0);

  const approval = page.waitForResponse((response) => response.url().endsWith('/approve'));
  await page.getByRole('button', { name: 'Approve & upload', exact: true }).click();
  const response = await approval;
  expect(response.status()).toBe(200);
  expect(Object.keys(response.request().postDataJSON() as object).sort()).toEqual([
    'channelId',
    'description',
    'pickVersion',
    'tags',
    'title',
  ]);
});

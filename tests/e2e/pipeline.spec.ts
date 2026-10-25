import { expect, test, type Page } from '@playwright/test';
import { signIn, USER_A, USER_C } from './session';

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

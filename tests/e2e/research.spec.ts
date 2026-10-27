import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { rejectUser, researchUser, signIn } from './session';

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const peerCount = (page: Page, count: number) => page.getByText(`Similar artists (${count})`);

/** Walks the draft's four screens with the clicks a release always needed. */
async function toApproval(page: Page, job: string) {
  await page.goto(`/jobs/${job}`);
  await button(page, 'Keep it, next').click();
  await button(page, 'Looks right, next').click();
  await button(page, 'Fine, next').click();
  await expect(h1(page)).toHaveText('Ready to upload');
}

const project = (testInfo: TestInfo) => testInfo.project.name;

test('waits on research before it drafts', async ({ page }, testInfo) => {
  await signIn(page, researchUser(testInfo));
  await page.goto(`/jobs/e2e-research-wait-${project(testInfo)}`);
  // The queue fake finishes the run, so the next poll reaches the model, which is busy here.
  await expect(h1(page)).toHaveText('Researching similar artists');
  await expect(h1(page)).toHaveText('Model busy');
});

test.describe('a finished run on the last screen', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await signIn(page, researchUser(testInfo));
    await toApproval(page, `e2e-research-${project(testInfo)}`);
  });

  test('shows the recommendation with the ranges and the limits', async ({ page }) => {
    const panel = page.getByRole('region', { name: 'Recommendation' });
    await expect(panel).toContainText('Open on the chorus hook.');
    await expect(panel).toContainText('More listeners reach the second minute.');
    await expect(panel).toContainText('Your range: 100–999 subscribers');
    await expect(panel).toContainText('Next range: 1,000–9,999.');
    await expect(panel).toContainText(
      'Similar artists were matched on their titles and tags, not by listening.',
    );
  });

  test('shows the artist’s own results with the calculated net labeled', async ({ page }) => {
    const results = page.getByRole('region', { name: 'Your results (YouTube Analytics)' });
    await expect(results).toContainText('Last Light');
    await expect(results).toContainText('still collecting');
    await expect(results).toContainText("on this video's page; a lower bound");
    await expect(results.getByText('Net subscribers').locator('..')).toContainText('+10');
    await expect(results.getByText('Net subscribers').locator('..')).toContainText('calculated');
  });

  test('lists the peers with their basis, reported reach and calculated engagement', async ({
    page,
  }) => {
    await peerCount(page, 3).click();
    const first = page.locator('li.peer', { hasText: 'Neon Harbor' });
    await expect(first).toContainText('Heard');
    await expect(first).toContainText('1,200 subscribers · 40 videos · 90,000 views');
    await expect(first).toContainText('Public reach on YouTube');
    await expect(first).toContainText('Night Drive');
    await expect(first).toContainText('engagement 10.0% (calculated)');
    const last = page.locator('li.peer', { hasText: 'Moonline Ghosts' });
    await expect(last).toContainText('Metadata only');
    await expect(last).toContainText('Secondary');
  });
});

test('names the sources behind a field, and says when a peer’s evidence has expired', async ({
  page,
}, testInfo) => {
  await signIn(page, researchUser(testInfo));
  await page.goto(`/jobs/e2e-research-${project(testInfo)}`);
  await expect(page.getByText(/^Sources:/)).toContainText('P1-R1 · Night Drive');
  await button(page, 'Keep it, next').click();
  await button(page, 'Looks right, next').click();
  await expect(h1(page)).toHaveText('Check the tags');
  await expect(page.getByText(/^Sources:/)).toContainText('Peer evidence expired on Nov 20, 2026');
});

test('removes a peer with Not a peer, and keeps it removed after a reload', async ({
  page,
}, testInfo) => {
  await signIn(page, rejectUser(testInfo));
  await toApproval(page, `e2e-reject-${project(testInfo)}`);
  await peerCount(page, 3).click();
  const harbor = page.locator('li.peer', { hasText: 'Neon Harbor' });
  const reject = page.waitForResponse((response) => response.url().endsWith('/reject'));
  await harbor.getByRole('button', { name: 'Not a peer' }).click();
  expect((await reject).status()).toBe(200);
  await expect(peerCount(page, 2)).toBeVisible();
  await expect(page.locator('li.peer', { hasText: 'Neon Harbor' })).toHaveCount(0);

  await page.reload();
  await expect(h1(page)).toHaveText('Ready to upload');
  await expect(peerCount(page, 2)).toBeVisible();
});

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { signIn, USER_UPLOAD } from './session';

// The fake GCS session server (tests/e2e/fakes/gcs-session.ts) sends at 128 KiB/s by default, so a
// clip takes a few seconds and a test can act mid-upload.
const FAKE = 'http://localhost:4174';
const CLIP_A = join(import.meta.dirname, 'fixtures/clip-a.webm');
const SIZE_A = statSync(CLIP_A).size;

type FakeSession = {
  id: string;
  object: string;
  size: number;
  saved: number;
  received: number;
  cancelled: boolean;
};

/** Starts a release on /new with `clip`; returns the job ID once the job page opens. */
async function startRelease(page: Page, clip = CLIP_A): Promise<string> {
  await signIn(page, USER_UPLOAD);
  await page.goto('/new');
  await page.locator('#video').setInputFiles(clip);
  await page.getByLabel("What's the song called?").fill('Upload check');
  const start = page.getByRole('button', { name: 'Start the release' });
  await expect(start).toBeEnabled();
  await start.click();
  await page.waitForURL(/\/jobs\/[\w-]+$/);
  return page.url().split('/').pop()!;
}

async function sessions(page: Page, id: string): Promise<FakeSession[]> {
  const response = await page.request.get(`${FAKE}/control/sessions?prefix=uploads/${id}/`);
  return (await response.json()) as FakeSession[];
}

async function control(page: Page, route: string, params: Record<string, string | number>) {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const response = await page.request.post(`${FAKE}/control/${route}?${query}`);
  expect(response.ok()).toBe(true);
}

async function jobState(page: Page, id: string): Promise<string> {
  const response = await page.request.get(`/api/jobs/${id}`);
  return ((await response.json()) as { job: { state: string } }).job.state;
}

/** E2E has no ffmpeg, so a landed upload moves to PREP and may fail there; both left the upload. */
const leftUpload = async (page: Page, id: string) =>
  expect.poll(() => jobState(page, id), { timeout: 60_000 }).not.toBe('AWAITING_UPLOAD');

const status = (page: Page) => page.getByRole('status');

/** Slows the session so the test acts mid-upload; returns it with what it saved so far. */
async function midUpload(page: Page, id: string): Promise<FakeSession> {
  const [session] = await sessions(page, id);
  await control(page, 'throttle', { session: session!.id, bytesPerSec: 48 * 1024 });
  const [now] = await sessions(page, id);
  expect(now!.saved).toBeLessThan(SIZE_A / 2);
  return now!;
}

test.describe('a dropped connection', () => {
  test('resumes after drops on its own, sending little more than the file', async ({ page }) => {
    test.setTimeout(90_000);
    const id = await startRelease(page);
    const session = await midUpload(page, id);
    for (const step of [1, 2, 3]) {
      const after = session.saved + Math.floor((SIZE_A / 8) * step);
      await control(page, 'drop', { session: session.id, after });
    }
    await expect(status(page)).toHaveText('Upload paused: no connection');
    await leftUpload(page, id);
    const [done] = await sessions(page, id);
    expect(done!.saved).toBe(SIZE_A);
    expect(done!.received).toBeLessThan(2 * SIZE_A);
  });

  test('rides out failed requests and storage errors with no click', async ({ page }) => {
    test.setTimeout(120_000);
    // A routed request loses its Blob body in Chromium, so the link goes offline instead.
    let failed = 0;
    page.on('requestfailed', () => failed++);
    const id = await startRelease(page);
    const session = await midUpload(page, id);
    await page.context().setOffline(true);
    // Chromium resends a PUT once, unseen, when a reused connection resets; the second drop shows.
    for (const after of [16 * 1024, 32 * 1024]) {
      await control(page, 'drop', { session: session.id, after: session.saved + after });
    }
    await expect(status(page)).toHaveText('Upload paused: no connection');
    await expect.poll(() => failed, { timeout: 60_000 }).toBeGreaterThanOrEqual(5);
    await control(page, 'fail', { session: session.id, status: 503, times: 2 });
    await page.context().setOffline(false);
    await expect(status(page)).toHaveText('Upload paused: storage busy, retrying');
    await leftUpload(page, id);
    const [done] = await sessions(page, id);
    expect(done!.saved).toBe(SIZE_A);
  });
});

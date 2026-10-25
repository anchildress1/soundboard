// Fixtures are synthetic (never Nathan's media), VP9 + Opus so Chromium plays them:
//   ffmpeg -f lavfi -i testsrc2=size=320x240:rate=24 -f lavfi -i sine=frequency=440 -t 4 \
//     -c:v libvpx-vp9 -b:v 1500k -c:a libopus tests/e2e/fixtures/clip-a.webm
//   ffmpeg -f lavfi -i testsrc2=size=320x240:rate=24 -f lavfi -i sine=frequency=660 -t 4 \
//     -vf hue=h=90 -c:v libvpx-vp9 -b:v 1500k -c:a libopus tests/e2e/fixtures/clip-b.webm
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { signIn, USER_UPLOAD } from './session';

// The fake GCS session server (tests/e2e/fakes/gcs-session.ts) sends at 128 KiB/s by default, so a
// clip takes a few seconds and a test can act mid-upload.
const FAKE = 'http://localhost:4174';
const CLIP_A = join(import.meta.dirname, 'fixtures/clip-a.webm');
const CLIP_B = join(import.meta.dirname, 'fixtures/clip-b.webm');
const SIZE_A = statSync(CLIP_A).size;
const SIZE_B = statSync(CLIP_B).size;
const KIB = 1024;

type FakeSession = {
  id: string;
  object: string;
  size: number;
  saved: number;
  received: number;
  puts: number[];
  cancelled: boolean;
};

type Files = Parameters<Locator['setInputFiles']>[0];

/**
 * Picks `files` until `done` shows. A pick before hydration lands on the server-rendered input with
 * no handler attached, and nothing happens. Chromium fires no change for the same file again, so
 * each try clears the input first.
 */
async function choose(input: Locator, files: Files, done: Locator) {
  await expect(async () => {
    await input.setInputFiles([]);
    await input.setInputFiles(files);
    await expect(done).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
}

/** Starts a release on /new with `clip`; returns the job ID once the job page opens. */
async function startRelease(page: Page, name = 'Upload check', clip = CLIP_A): Promise<string> {
  // Both projects share the upload user, so a title names its project to stay unique.
  const title = `${name} (${test.info().project.name})`;
  await signIn(page, USER_UPLOAD);
  await page.goto('/new');
  await choose(page.locator('#video'), clip, page.locator('video'));
  await page.getByLabel("What's the song called?").fill(title);
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

/**
 * Resolves once the status reads `text`, however briefly: a pause can last one 1 s backoff, which
 * an assertion's slowing poll can miss. Start it before the action that causes the state.
 */
const shows = (page: Page, text: string) =>
  page.waitForFunction(
    (wanted) => document.querySelector('[role="status"]')?.textContent?.trim() === wanted,
    text,
    { polling: 'raf', timeout: 30_000 },
  );
const picker = (page: Page) => page.getByLabel('Pick the video');

/** The fake's answer to a status query on `session`, as the browser would send it. */
async function statusQuery(page: Page, session: FakeSession): Promise<number> {
  const response = await page.request.put(`${FAKE}/upload/${session.id}`, {
    headers: { 'content-range': `bytes */${session.size}` },
  });
  return response.status();
}

/** Waits until the fake saved more than `bytes` of the job's upload. */
const savedOver = async (page: Page, id: string, bytes: number) =>
  expect.poll(async () => (await sessions(page, id))[0]!.saved).toBeGreaterThan(bytes);

/** A second browser context like this project's, signed in as the upload user. */
async function otherDevice(browser: Browser, testInfo: TestInfo): Promise<Page> {
  const { baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } =
    testInfo.project.use;
  const context = await browser.newContext({
    baseURL,
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
  });
  const page = await context.newPage();
  await signIn(page, USER_UPLOAD);
  return page;
}

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
    const paused = shows(page, 'Upload paused: no connection');
    for (const step of [1, 2, 3]) {
      await control(page, 'drop', { session: session.id, ahead: Math.floor((SIZE_A / 8) * step) });
    }
    await paused;
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
    for (const ahead of [16 * KIB, 32 * KIB]) {
      await control(page, 'drop', { session: session.id, ahead });
    }
    await expect(status(page)).toHaveText('Upload paused: no connection');
    await expect.poll(() => failed, { timeout: 60_000 }).toBeGreaterThanOrEqual(5);
    await control(page, 'fail', { session: session.id, status: 503, times: 2 });
    const busy = shows(page, 'Upload paused: storage busy, retrying');
    await page.context().setOffline(false);
    await busy;
    await leftUpload(page, id);
    const [done] = await sessions(page, id);
    expect(done!.saved).toBe(SIZE_A);
  });
});

test.describe('leaving the job page', () => {
  test('keeps sending while the rest of the app is open', async ({ page }) => {
    test.setTimeout(90_000);
    const id = await startRelease(page, 'Upload away');
    const session = await midUpload(page, id);
    await page.getByRole('link', { name: /^Back to releases/ }).click();
    await page.waitForURL('/');
    const row = page.getByRole('region').filter({ has: page.locator(`a[href="/jobs/${id}"]`) });
    await expect(row).toContainText('Uploading');
    await expect(row.getByRole('link', { name: /^Open/ })).toHaveAttribute('href', `/jobs/${id}`);
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('link', { name: 'Connections' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();
    await savedOver(page, id, session.saved);
    await page.goBack();
    await row.getByRole('link', { name: /^Open/ }).click();
    await page.waitForURL(`/jobs/${id}`);
    await control(page, 'throttle', { session: session.id, bytesPerSec: 1024 * KIB });
    await leftUpload(page, id);
    expect(await sessions(page, id)).toHaveLength(1);
  });
});

test.describe('after a reload', () => {
  test('the same video continues from what was saved', async ({ page }) => {
    test.setTimeout(90_000);
    const id = await startRelease(page, 'Upload same');
    await midUpload(page, id);
    await savedOver(page, id, SIZE_A / 10);
    await page.reload();
    await expect(status(page)).toHaveText(/^Upload paused at [1-9]\d*%\. Pick the video/);
    const [before] = await sessions(page, id);
    await control(page, 'throttle', { session: before!.id, bytesPerSec: 1024 * KIB });
    await choose(picker(page), CLIP_A, page.locator('video'));
    await leftUpload(page, id);
    const all = await sessions(page, id);
    expect(all).toHaveLength(1);
    expect(all[0]!.saved).toBe(SIZE_A);
    // Bytes the closed page already handed the network still arrive; only the new PUTs count.
    const resent = all[0]!.puts.slice(before!.puts.length).reduce((sum, n) => sum + n, 0);
    expect(resent).toBeGreaterThan(0);
    expect(resent).toBeLessThan(SIZE_A - before!.saved + 256 * KIB);
  });

  test('a different video starts over, and only it lands', async ({ page }) => {
    test.setTimeout(90_000);
    const id = await startRelease(page, 'Upload other');
    await midUpload(page, id);
    await savedOver(page, id, 0);
    await page.reload();
    await expect(picker(page)).toBeVisible();
    await choose(picker(page), CLIP_B, page.locator('video'));
    await expect(page.getByRole('note')).toHaveText('New video: starting the upload over.');
    await leftUpload(page, id);
    const [old, current] = await sessions(page, id);
    expect(old!.cancelled).toBe(true);
    expect(await statusQuery(page, old!)).toBe(404);
    expect(current!.saved).toBe(SIZE_B);
    const response = await page.request.get(`${FAKE}/control/objects?prefix=uploads/${id}/`);
    expect(await response.json()).toEqual([
      { name: current!.object, size: SIZE_B, contentType: 'video/webm' },
    ]);
  });

  test("a file the browser can't play asks again", async ({ page }) => {
    test.setTimeout(60_000);
    const id = await startRelease(page, 'Upload unreadable');
    await midUpload(page, id);
    await page.reload();
    const bogus = {
      name: 'not-a-video.webm',
      mimeType: 'video/webm',
      buffer: Buffer.from('this is not a video'),
    };
    const unreadable = page.getByText("Couldn't read this video. Pick it again.");
    await choose(picker(page), bogus, unreadable);
    await expect(status(page)).toHaveText("Couldn't read this video. Pick it again.");
    await expect(picker(page)).toBeVisible();
    expect(await sessions(page, id)).toHaveLength(1);
  });

  test('moves on with no picker when the last byte landed before the reply', async ({ page }) => {
    test.setTimeout(60_000);
    const id = await startRelease(page, 'Upload landed');
    const [session] = await sessions(page, id);
    await control(page, 'hold', { session: session!.id });
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `${FAKE}/control/object/${encodeURIComponent(session!.object)}`,
        );
        return ((await response.json()) as { landed: boolean }).landed;
      })
      .toBe(true);
    const context = page.context();
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(`/jobs/${id}`);
    await leftUpload(reopened, id);
    await expect(picker(reopened)).toHaveCount(0);
  });
});

test.describe('one sender', () => {
  test('a second page waits on the first, then asks for the file', async ({ page }) => {
    test.setTimeout(90_000);
    const id = await startRelease(page, 'Upload two pages');
    await midUpload(page, id);
    const second = await page.context().newPage();
    await second.goto(`/jobs/${id}`);
    await expect(status(second)).toHaveText('Uploading in another tab');
    await expect(picker(second)).toHaveCount(0);
    await page.close();
    await expect(status(second)).toHaveText(/Pick the video to continue\.$/);
    await expect(picker(second)).toBeVisible();
  });

  test('a pick on another device moves the upload there', async ({ page, browser }, testInfo) => {
    test.setTimeout(150_000);
    const id = await startRelease(page, 'Upload moved');
    const [session] = await sessions(page, id);
    await control(page, 'throttle', { session: session!.id, bytesPerSec: 4 * KIB });
    const device = await otherDevice(browser, testInfo);
    try {
      await device.goto(`/jobs/${id}`);
      await choose(picker(device), CLIP_A, device.locator('video'));
      await expect(status(device)).toHaveText(/^Uploading \d+%$/);
      await expect(status(page)).toHaveText('The upload moved to another device or window.', {
        timeout: 45_000,
      });
      let late = 0;
      page.on('request', (request) => {
        if (request.url().startsWith(`${FAKE}/upload/`)) late++;
      });
      await control(page, 'throttle', { session: session!.id, bytesPerSec: 1024 * KIB });
      await leftUpload(device, id);
      expect(await sessions(page, id)).toHaveLength(1);
      expect(late).toBe(0);
    } finally {
      await device.context().close();
    }
  });
});

test.describe('discard', () => {
  test('stops the upload and leaves nothing in storage', async ({ page }) => {
    test.setTimeout(60_000);
    const id = await startRelease(page, 'Upload discard');
    const session = await midUpload(page, id);
    await page.getByRole('button', { name: 'Discard' }).click();
    await page.waitForURL('/');
    expect(await jobState(page, id)).toBe('DISCARDED');
    const response = await page.request.get(`${FAKE}/control/objects?prefix=uploads/${id}/`);
    expect(await response.json()).toEqual([]);
    expect(await statusQuery(page, session)).toBe(404);
  });
});

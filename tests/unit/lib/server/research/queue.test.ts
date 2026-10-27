// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { researchRuns } from '#lib/server/core/schema.js';
import { DeadlineSpent } from '#lib/server/platforms/youtube/index.js';
import { enqueue } from '#lib/server/research/queue.js';
import { captureException } from '../../../../mocks/sentry';
import { seed, truncate } from '../../../../helpers/db';
import { A_JOB, json, seedJob, USERS, USER_A } from '../../../../helpers/pipeline';

const h = vi.hoisted(() => ({
  getAccessToken: vi.fn<() => Promise<string | null>>(),
  scopes: [] as unknown[],
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(options: { scopes: unknown }) {
      h.scopes.push(options.scopes);
    }
    getAccessToken = h.getAccessToken;
  },
}));

const QUEUE = 'projects/p/locations/us-central1/queues/soundboard-research';
const URL_ = 'https://soundboard-123.us-central1.run.app/api/research/task';
const SA = 'research@p.iam.gserviceaccount.com';
const DELIVERY = { jobId: 'j1', uid: 'uid-a', runId: 'run-1', seq: 2 };
const later = () => Date.now() + 60_000;

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (call = 0) =>
  JSON.parse(String(fetchMock.mock.calls[call]![1]!.body)) as {
    task: {
      name: string;
      scheduleTime?: string;
      dispatchDeadline: string;
      httpRequest: { body: string; [key: string]: unknown };
    };
  };

/** A fetch that never answers until its signal aborts, as a stalled connection does. */
const stalled = (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  });

beforeEach(() => {
  fetchMock.mockReset();
  h.getAccessToken.mockReset().mockResolvedValue('tasks-access-token');
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('RESEARCH_QUEUE', QUEUE);
  vi.stubEnv('RESEARCH_TASK_URL', URL_);
  vi.stubEnv('RESEARCH_TASK_SA', SA);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('enqueue', () => {
  it("creates the contract's named, scheduled task with an OIDC token for the service account", async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    const at = Date.now() + 60_000;
    await enqueue(DELIVERY, at, later());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://cloudtasks.googleapis.com/v2/${QUEUE}/tasks`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer tasks-access-token' });
    expect(h.scopes).toEqual([['https://www.googleapis.com/auth/cloud-platform']]);
    const { task } = bodyOf();
    expect(task).toMatchObject({
      name: `${QUEUE}/tasks/run-1-2`,
      scheduleTime: new Date(at).toISOString(),
      dispatchDeadline: '180s',
      httpRequest: {
        httpMethod: 'POST',
        url: URL_,
        headers: { 'Content-Type': 'application/json' },
        oidcToken: { serviceAccountEmail: SA, audience: URL_ },
      },
    });
    expect(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString())).toEqual(DELIVERY);
  });

  it('leaves out scheduleTime for a task due now', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    await enqueue(DELIVERY, Date.now() - 1, later());
    expect(bodyOf().task).not.toHaveProperty('scheduleTime');
  });

  it('counts an existing task of the same name as enqueued', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 409 }));
    await expect(enqueue(DELIVERY, Date.now(), later())).resolves.toBeUndefined();
  });

  it('throws on any other refusal', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(enqueue(DELIVERY, Date.now(), later())).rejects.toThrow('Cloud Tasks 500');
  });

  it('throws when ADC yields no token, without calling the queue', async () => {
    h.getAccessToken.mockResolvedValue(null);
    await expect(enqueue(DELIVERY, Date.now(), later())).rejects.toThrow('No access token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends a stalled token fetch at the step deadline', async () => {
    h.getAccessToken.mockReturnValue(new Promise(() => {}));
    await expect(enqueue(DELIVERY, Date.now(), Date.now() + 50)).rejects.toBeInstanceOf(
      DeadlineSpent,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends a stalled request at the step deadline', async () => {
    fetchMock.mockImplementation(stalled);
    await expect(enqueue(DELIVERY, Date.now(), Date.now() + 50)).rejects.toBeInstanceOf(
      DeadlineSpent,
    );
  });

  it('starts nothing once the deadline has passed', async () => {
    await expect(enqueue(DELIVERY, Date.now(), Date.now() - 1)).rejects.toBeInstanceOf(
      DeadlineSpent,
    );
    expect(h.getAccessToken).not.toHaveBeenCalled();
  });

  it('passes on a network failure that is not the deadline', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(enqueue(DELIVERY, Date.now(), later())).rejects.toThrow('fetch failed');
  });

  it('throws in a build without a queue', async () => {
    vi.stubEnv('RESEARCH_QUEUE', '');
    vi.stubEnv('RESEARCH_TASK_URL', '');
    vi.stubEnv('RESEARCH_TASK_SA', '');
    vi.stubEnv('DEV', false);
    await expect(enqueue(DELIVERY, Date.now(), later())).rejects.toThrow(
      'RESEARCH_QUEUE is not configured.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('enqueue in dev without a queue', () => {
  beforeEach(async () => {
    await truncate();
    await seed(USERS);
    vi.stubEnv('RESEARCH_QUEUE', '');
    vi.stubEnv('RESEARCH_TASK_URL', '');
    vi.stubEnv('RESEARCH_TASK_SA', '');
    vi.stubEnv('DEV', true);
    vi.stubEnv('YOUTUBE_API_KEY', 'yt-key');
    // The genre search finds nothing, so discover ends the run.
    fetchMock.mockImplementation(async () => json({ items: [] }));
  });

  it('runs every delivery in-process until the run is done, calling no queue', async () => {
    await seedJob({ ...A_JOB, id: 'j1', state: 'PICK' });
    await seed({
      researchRuns: [
        {
          jobId: 'j1',
          id: 'run-1',
          ownerUid: USER_A.uid,
          artistId: USER_A.artistId,
          stage: 'learn',
        },
      ],
    });
    await enqueue({ jobId: 'j1', uid: USER_A.uid, runId: 'run-1', seq: 0 }, Date.now(), later());
    await vi.waitFor(
      async () => {
        const [run] = await db().select().from(researchRuns).where(eq(researchRuns.jobId, 'j1'));
        expect(run).toMatchObject({
          stage: 'done',
          seq: 2,
          limits: ['analytics-not-shared', 'artist-range-unknown', 'no-peers'],
          claimToken: null,
        });
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContainEqual(
      expect.stringContaining('cloudtasks'),
    );
  });

  it('retries a delivery that throws, as the queue retries a 500', async () => {
    await seedJob({ ...A_JOB, id: 'j1', state: 'PICK' });
    await seedJob({ ...A_JOB, id: 'j2', state: 'PICK' });
    await seed({
      researchRuns: [
        {
          jobId: 'j1',
          id: 'run-1',
          ownerUid: USER_A.uid,
          artistId: USER_A.artistId,
          stage: 'discover',
        },
      ],
      // Evidence under this run id for another job: every save of the batch throws.
      jobResearch: [{ runId: 'run-1', jobId: 'j2', retrievedAt: new Date(), evidence: {} }],
    });
    await enqueue({ jobId: 'j1', uid: USER_A.uid, runId: 'run-1', seq: 0 }, Date.now(), later());
    await vi.waitFor(
      () =>
        expect(
          vi
            .mocked(captureException)
            .mock.calls.filter(
              ([, hint]) =>
                (hint as { tags?: { component?: string } }).tags?.component === 'research',
            ).length,
        ).toBeGreaterThanOrEqual(2),
      { timeout: 10_000, interval: 50 },
    );
    const [run] = await db().select().from(researchRuns).where(eq(researchRuns.jobId, 'j1'));
    expect(run).toMatchObject({ stage: 'discover', seq: 0 });
  }, 15_000);
});

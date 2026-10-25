// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { jobs, researchRuns } from '#lib/server/core/schema.js';
import { POST } from '#src/routes/api/research/task/+server.js';
import { seed, truncate } from '../../../../../helpers/db';
import { A_JOB, seedJob, USERS, USER_A, USER_C } from '../../../../../helpers/pipeline';

const TASK_URL = 'https://soundboard-1.us-central1.run.app/api/research/task';
const SA = 'research@p.iam.gserviceaccount.com';
const QUEUE = 'projects/p/locations/us-central1/queues/soundboard-research';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn<
    (options: { idToken: string; audience: string }) => Promise<{
      getPayload: () => Record<string, unknown> | undefined;
    }>
  >(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = h.verifyIdToken;
  },
  GoogleAuth: class {
    getAccessToken = async () => 'ya29.token';
  },
}));

type Event = Parameters<typeof POST>[0];

const DELIVERY = { jobId: 'j1', uid: USER_A.uid, runId: 'run-1', seq: 0 };
const fetchMock = vi.fn<typeof fetch>();

/** Google accepts `good` for the task URL audience; anything else fails verification. */
function google(payload: Record<string, unknown> = { email: SA, email_verified: true }) {
  h.verifyIdToken.mockImplementation(async ({ idToken, audience }) => {
    if (idToken !== 'good' || audience !== TASK_URL) throw new Error('Wrong recipient');
    return { getPayload: () => payload };
  });
}

const deliver = (body: unknown, authorization: string | null = 'Bearer good') =>
  POST({
    request: new Request(TASK_URL, {
      method: 'POST',
      headers: authorization ? { authorization } : {},
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  } as unknown as Event);

const stored = async () =>
  (await db().select().from(researchRuns).where(eq(researchRuns.jobId, 'j1')))[0];

beforeEach(async () => {
  await truncate();
  await seed(USERS);
  await seedJob({ ...A_JOB, id: 'j1', state: 'PICK' });
  await seed({
    researchRuns: [
      { jobId: 'j1', id: 'run-1', ownerUid: USER_A.uid, artistId: USER_A.artistId, stage: 'learn' },
    ],
  });
  google();
  fetchMock.mockReset().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('RESEARCH_QUEUE', QUEUE);
  vi.stubEnv('RESEARCH_TASK_URL', TASK_URL);
  vi.stubEnv('RESEARCH_TASK_SA', SA);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/research/task', () => {
  it('runs one batch for a verified Cloud Tasks delivery', async () => {
    const response = await deliver(DELIVERY);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(await stored()).toMatchObject({ stage: 'discover', seq: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no token', null],
    ['a non-bearer header', 'Basic good'],
    ['a bad token', 'Bearer forged'],
  ])('answers 401 with %s, reading and writing nothing', async (_name, authorization) => {
    const before = await stored();
    const response = await deliver(DELIVERY, authorization);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
    expect(await stored()).toEqual(before);
  });

  it('answers 401 for a token minted for another audience', async () => {
    vi.stubEnv('RESEARCH_TASK_URL', 'https://elsewhere.run.app/api/research/task');
    expect((await deliver(DELIVERY)).status).toBe(401);
  });

  it.each([
    ['another service account', { email: 'other@p.iam.gserviceaccount.com', email_verified: true }],
    ['an unverified email', { email: SA, email_verified: false }],
    ['no email', {}],
  ])('answers 401 for %s', async (_name, payload) => {
    google(payload);
    expect((await deliver(DELIVERY)).status).toBe(401);
    expect((await stored())?.seq).toBe(0);
  });

  it('answers 401 without a configured queue, since nothing could have minted the token', async () => {
    vi.stubEnv('RESEARCH_QUEUE', '');
    vi.stubEnv('RESEARCH_TASK_URL', '');
    vi.stubEnv('RESEARCH_TASK_SA', '');
    expect((await deliver(DELIVERY)).status).toBe(401);
    expect(h.verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', 'nope'],
    ['an array', [DELIVERY]],
    ['a missing runId', { ...DELIVERY, runId: undefined }],
    ['an empty uid', { ...DELIVERY, uid: '' }],
    ['a fractional seq', { ...DELIVERY, seq: 1.5 }],
    ['a negative seq', { ...DELIVERY, seq: -1 }],
    ['a string seq', { ...DELIVERY, seq: '0' }],
  ])('answers 400 for %s', async (_name, body) => {
    expect((await deliver(body)).status).toBe(400);
    expect((await stored())?.seq).toBe(0);
  });

  it.each([
    ['uid', { uid: USER_C.uid }],
    ['jobId', { jobId: 'j2' }],
  ])(
    "answers 200 and changes nothing for a delivery whose %s doesn't match the row",
    async (_name, patch) => {
      const before = await stored();
      expect((await deliver({ ...DELIVERY, ...patch })).status).toBe(200);
      expect(await stored()).toEqual(before);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('answers 200 for a discarded job and leaves its run alone', async () => {
    await db().update(jobs).set({ state: 'DISCARDED' }).where(eq(jobs.id, 'j1'));
    expect((await deliver(DELIVERY)).status).toBe(200);
    expect((await stored())?.seq).toBe(0);
  });

  it('answers 503 for a delivery ahead of the row', async () => {
    const response = await deliver({ ...DELIVERY, seq: 1 });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('');
  });

  it('answers 500 with nothing written when the next enqueue fails', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
    expect((await deliver(DELIVERY)).status).toBe(500);
    expect(await stored()).toMatchObject({ stage: 'learn', seq: 0, claimToken: null });
  });
});

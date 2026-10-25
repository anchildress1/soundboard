// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { getJob } from '#lib/server/jobs/jobs.js';
import { POST } from '#src/routes/api/jobs/[id]/discard/+server.js';
import type { JobState, JobView } from '#lib/types.js';
import { seed, truncate, vanishOnUpdate } from '../../../../../../helpers/db';
import { gcs, resetGcs, seedSession, sessionFetch } from '../../../../../../helpers/gcs';
import { sealed, seedJob, USER_A, USER_B, USERS } from '../../../../../../helpers/pipeline';

vi.mock('@google-cloud/storage', () => import('../../../../../../helpers/gcs'));
vi.mock('@google-cloud/kms', () => import('../../../../../../e2e/fakes/kms'));

type Event = Parameters<typeof POST>[0];

const discard = async (id: string, user: typeof USER_A | typeof USER_B = USER_B) =>
  POST({ params: { id }, locals: { user } } as unknown as Event);

const state = async (id: string) => (await getJob(id))!.state;

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  vi.stubGlobal('fetch', sessionFetch);
  resetGcs();
  resetClients();
  await truncate();
  await seed(USERS);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const uploading = () => {
  const uri = seedSession('uploads/j1/a', 100, 10);
  return seedJob({
    state: 'AWAITING_UPLOAD',
    object: 'uploads/j1/a',
    videoUpload: {
      sessionCipher: sealed(uri),
      generation: 1,
      size: 100,
      fingerprint: 'a'.repeat(64),
      ops: [],
    },
  }).then(() => uri);
};

describe('POST /api/jobs/[id]/discard', () => {
  it('stops an unfinished browser upload', async () => {
    const uri = await uploading();
    const response = await discard('j1');
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobView).job.state).toBe('DISCARDED');
    expect(gcs.sessions.get(uri)!.cancelled).toBe(true);
  });

  it('answers 503 when the upload can’t be checked', async () => {
    await uploading();
    gcs.exists.mockRejectedValueOnce(new Error('503'));
    const response = await discard('j1');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "Couldn't check the upload. Try again." });
    expect(await state('j1')).toBe('AWAITING_UPLOAD');
  });

  it.each<JobState>(['REVIEW', 'ANALYZE', 'FAILED', 'PUBLISHING', 'CLAIMED_COMPLETE'])(
    'ends a %s job',
    async (from) => {
      await seedJob({ state: from });
      const response = await discard('j1');
      expect(response.status).toBe(200);
      expect(((await response.json()) as JobView).job.state).toBe('DISCARDED');
    },
  );

  it('409s once the upload is verified', async () => {
    await seedJob({ state: 'VERIFIED' });
    const response = await discard('j1');
    expect(response.status).toBe(409);
    expect(await state('j1')).toBe('VERIFIED');
  });

  it("404s another user's job and changes nothing", async () => {
    await seedJob({ state: 'REVIEW' });
    const error = await discard('j1', USER_A).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(await state('j1')).toBe('REVIEW');
  });

  it('answers with the loaded job if it disappears mid-request', async () => {
    await seedJob({ state: 'REVIEW' });
    await vanishOnUpdate();
    const response = await discard('j1');
    expect(response.status).toBe(200);
    expect(((await response.json()) as JobView).job.state).toBe('REVIEW');
  });
});

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { jobs } from '#lib/server/core/schema.js';
import { getJob } from '#lib/server/jobs/jobs.js';
import { POST } from '#src/routes/api/jobs/+server.js';
import { seed, truncate } from '../../../../helpers/db';
import { gcs, resetGcs } from '../../../../helpers/gcs';
import { sealed, USER_A, USER_B, USER_C, USERS } from '../../../../helpers/pipeline';

vi.mock('@google-cloud/storage', () => import('../../../../helpers/gcs'));
vi.mock('@google-cloud/kms', () => import('../../../../e2e/fakes/kms'));

type Event = Parameters<typeof POST>[0];
type User = typeof USER_A | typeof USER_B | typeof USER_C | null;

const post = (body: unknown, user: User = USER_C) =>
  POST({
    request: new Request('http://localhost/api/jobs', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    url: new URL('http://localhost:5173/api/jobs'),
    locals: { user },
  } as unknown as Event);

const upload = {
  songTitle: 'PeekaBoo',
  notes: 'first single',
  filename: 'peekaboo.mp4',
  contentType: 'video/mp4',
  size: 5_000_000,
  durationSec: 200,
  fingerprint: 'd'.repeat(64),
};

const jobCount = async () => (await db().select().from(jobs)).length;

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  resetClients();
  resetGcs();
  await truncate();
  await seed(USERS);
});

describe('POST /api/jobs', () => {
  it("creates the signed-in user's job with a session opened for the app's origin", async () => {
    const response = await post(upload, USER_A);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; sessionUri: string; generation: number };
    expect(body.sessionUri).toBe([...gcs.sessions.keys()][0]);
    expect(body.generation).toBe(1);
    expect(gcs.created[0]!.options).toMatchObject({ origin: 'http://localhost:5173' });
    expect(await getJob(body.id)).toMatchObject({
      ownerUid: USER_A.uid,
      artistId: 'flr',
      state: 'AWAITING_UPLOAD',
      object: gcs.created[0]!.object,
      videoUpload: { sessionCipher: sealed(body.sessionUri), generation: 1 },
    });
  });

  it('409s a user with no artist profile, opening no session and storing nothing', async () => {
    const response = await post(upload, USER_B);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Add your artist name first.', fields: null });
    expect(gcs.created).toEqual([]);
    expect(await jobCount()).toBe(0);
  });

  it("stores the owner's own profile on a non-Nathan job", async () => {
    const body = (await (await post(upload, USER_C)).json()) as { id: string };
    expect(await getJob(body.id)).toMatchObject({
      ownerUid: USER_C.uid,
      artistId: USER_C.artistId,
    });
  });

  it('400s a bad fingerprint and opens no session', async () => {
    const response = await post({ ...upload, fingerprint: 'nope' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Pick the video again.', fields: null });
    expect(gcs.created).toEqual([]);
    expect(await jobCount()).toBe(0);
  });

  it('passes a session failure to SvelteKit and stores nothing', async () => {
    gcs.createResumableUpload.mockRejectedValueOnce(new Error('denied'));
    await expect(post(upload)).rejects.toThrow('denied');
    expect(await jobCount()).toBe(0);
  });

  it('401s a signed-out request and stores nothing', async () => {
    const response = await post(upload, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Sign in first.', fields: null });
    expect(await jobCount()).toBe(0);
  });

  it('rejects a body that is not a JSON object', async () => {
    const response = await post('[]');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Expected a JSON object.',
      fields: null,
    });
    expect(await jobCount()).toBe(0);
  });
});

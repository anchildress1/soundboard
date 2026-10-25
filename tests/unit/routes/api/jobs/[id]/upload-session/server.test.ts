// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { getJob } from '#lib/server/jobs/jobs.js';
import { POST } from '#src/routes/api/jobs/[id]/upload-session/+server.js';
import { seed, truncate } from '../../../../../../helpers/db';
import { gcs, resetGcs, seedSession, sessionFetch } from '../../../../../../helpers/gcs';
import { sealed, seedJob, USER_A, USER_B, USERS } from '../../../../../../helpers/pipeline';

vi.mock('@google-cloud/storage', () => import('../../../../../../helpers/gcs'));
vi.mock('@google-cloud/kms', () => import('../../../../../../e2e/fakes/kms'));

type Event = Parameters<typeof POST>[0];
const FP = 'a'.repeat(64);
let uri: string;

const post = (body: unknown, user: typeof USER_A | typeof USER_B | null = USER_B) =>
  POST({
    params: { id: 'j1' },
    locals: { user },
    url: new URL('http://localhost:5173/api/jobs/j1/upload-session'),
    request: new Request('http://localhost:5173/api/jobs/j1/upload-session', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  } as unknown as Event);

const confirm = (generation: number) => ({ op: 'confirm', generation, fingerprint: FP });

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  vi.stubGlobal('fetch', sessionFetch);
  resetClients();
  resetGcs();
  await truncate();
  await seed(USERS);
  uri = seedSession('uploads/j1/a', 100);
  await seedJob({
    state: 'AWAITING_UPLOAD',
    object: 'uploads/j1/a',
    videoUpload: { sessionCipher: sealed(uri), generation: 2, size: 100, fingerprint: FP, ops: [] },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/jobs/[id]/upload-session', () => {
  it('answers a confirm for the owner', async () => {
    const response = await post(confirm(2));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ current: true });
  });

  it('opens new sessions for the request’s own origin', async () => {
    const response = await post({
      op: 'renew',
      opId: 'op-1',
      generation: 2,
      fingerprint: FP,
    });
    expect(response.status).toBe(200);
    expect(gcs.created[0]!.options).toMatchObject({ origin: 'http://localhost:5173' });
  });

  it('names the current generation in a superseded 409', async () => {
    const response = await post(confirm(1));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'The upload moved to another device or window.',
      generation: 2,
    });
  });

  it('answers other 409s and 400s in the usual shape', async () => {
    const malformed = await post('[]');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: 'Expected a JSON object.' });
    const unknown = await post({ op: 'start', fingerprint: FP });
    expect(unknown.status).toBe(400);
  });

  it.each([
    ['another user', USER_A],
    ['a signed-out caller', null],
  ])('404s %s and touches no session', async (_who, user) => {
    const error = await Promise.resolve(post(confirm(2), user)).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(sessionFetch).not.toHaveBeenCalled();
    expect((await getJob('j1'))!.videoUpload!.generation).toBe(2);
  });
});

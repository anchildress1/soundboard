// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { jobs } from '#lib/server/core/schema.js';
import { getJob } from '#lib/server/jobs/jobs.js';
import { POST } from '#src/routes/api/jobs/+server.js';
import { seed, truncate } from '../../../../helpers/db';
import { USER_A, USER_B, USERS } from '../../../../helpers/pipeline';

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      return {
        file: (object: string) => ({
          getSignedUrl: async ({ action }: { action: string }) => [
            `https://storage.googleapis.com/${name}/${object}?sig=${action}`,
          ],
        }),
      };
    }
  },
}));

type Event = Parameters<typeof POST>[0];
type User = typeof USER_A | typeof USER_B | null;

const post = (body: unknown, user: User = USER_B) =>
  POST({
    request: new Request('http://localhost/api/jobs', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    locals: { user },
  } as unknown as Event);

const upload = {
  songTitle: 'PeekaBoo',
  notes: 'first single',
  filename: 'peekaboo.mp4',
  contentType: 'video/mp4',
  size: 5_000_000,
  durationSec: 200,
};

const jobCount = async () => (await db().select().from(jobs)).length;

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  resetClients();
  await truncate();
  await seed(USERS);
});

describe('POST /api/jobs', () => {
  it("creates the signed-in user's job with a signed PUT URL", async () => {
    const response = await post(upload, USER_A);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; uploadUrl: string };
    expect(body.uploadUrl).toBe(`https://storage.googleapis.com/bkt/uploads/${body.id}?sig=write`);
    expect(await getJob(body.id)).toMatchObject({
      ownerUid: USER_A.uid,
      artistId: 'flr',
      state: 'AWAITING_UPLOAD',
    });
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

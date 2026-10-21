// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import { jobs } from '$lib/server/core/schema';
import { GET } from '$routes/api/jobs/[id]/+server';
import type { JobView } from '$lib/types';
import { seed, truncate } from '../../../../../helpers/db';
import { seedJob, USER_A, USER_B, USERS } from '../../../../../helpers/pipeline';

type Event = Parameters<typeof GET>[0];
type User = typeof USER_A | typeof USER_B | null;

const get = async (id: string, user: User = USER_B) =>
  GET({ params: { id }, locals: { user } } as unknown as Event);

async function thrown(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    return isHttpError(error) ? error.status : error;
  }
}

beforeEach(async () => {
  resetClients();
  await truncate();
  await seed(USERS);
  await seedJob({
    id: 'b',
    state: 'ANALYZE',
    chunkCount: 3,
    chunkIndex: 1,
    trace: { sentryTrace: 't', baggage: 'b' },
    upload: { sessionUri: 'https://upload.example/secret', total: 1 },
  });
});

describe('GET /api/jobs/[id]', () => {
  it('returns the public view of the job to its owner', async () => {
    await db()
      .update(jobs)
      .set({ chunks: [{ index: 0 }] })
      .where(eq(jobs.id, 'b'));
    const response = await get('b');
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job).toMatchObject({ id: 'b', state: 'ANALYZE', chunkIndex: 1 });
    expect(view.chunks).toHaveLength(1);
    expect(view.pick).toBeNull();
    expect(JSON.stringify(view)).not.toContain('upload.example/secret');
    expect(JSON.stringify(view)).not.toContain(USER_B.uid);
  });

  it("404s another user's job, and any job when signed out", async () => {
    expect(await thrown(get('b', USER_A))).toBe(404);
    expect(await thrown(get('b', null))).toBe(404);
  });

  it('404s an unknown job', async () => {
    expect(await thrown(get('ghost'))).toBe(404);
  });
});

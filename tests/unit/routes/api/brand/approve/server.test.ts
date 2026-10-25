// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { artistMemory } from '#lib/server/core/schema.js';
import { POST } from '#src/routes/api/brand/approve/+server.js';
import { seed, truncate } from '../../../../../helpers/db';
import { USER_A, USER_B, USER_C, USERS } from '../../../../../helpers/pipeline';

type Event = Parameters<typeof POST>[0];
const GUIDE = { statement: 'Plain titles.', keep: ['Song only'], fix: [], drop: [] };

const approve = (body: string, user: typeof USER_A | typeof USER_B | typeof USER_C = USER_A) =>
  POST({
    locals: { user },
    request: new Request('https://soundboard.test/api/brand/approve', { method: 'POST', body }),
  } as unknown as Event);

const has = async (slot: 'proposal' | 'approved') =>
  (await db().select().from(artistMemory).where(eq(artistMemory.key, slot))).length > 0;

beforeEach(async () => {
  resetClients();
  await truncate();
  await seed(USERS);
  await seed({
    artistMemory: [
      {
        artistId: 'flr',
        kind: 'brand',
        key: 'proposal',
        data: { ...GUIDE, status: 'PROPOSED', uploadCount: 1, createdAt: 1, approvedAt: null },
      },
    ],
  });
});

describe('POST /api/brand/approve', () => {
  it.each([
    ['without a profile', USER_B],
    ['on a profile that is not curated', USER_C],
  ])('404s for a user %s and leaves the proposal', async (_label, user) => {
    const error = await Promise.resolve()
      .then(() => approve(JSON.stringify({ ...GUIDE, proposedAt: 1 }), user))
      .catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(await has('proposal')).toBe(true);
  });

  it('approves the posted guide', async () => {
    const response = await approve(JSON.stringify({ ...GUIDE, proposedAt: 1 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      approved: { ...GUIDE, status: 'APPROVED', uploadCount: 1 },
    });
    expect(await has('approved')).toBe(true);
  });

  it('400s on a body that is not JSON', async () => {
    expect((await approve('not json')).status).toBe(400);
  });

  it('422s with the validation message', async () => {
    const response = await approve(JSON.stringify({ ...GUIDE, statement: '', proposedAt: 1 }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toMatch(/statement/);
  });
});

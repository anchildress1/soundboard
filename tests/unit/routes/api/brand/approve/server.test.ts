// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import { artistBrand } from '$lib/server/core/schema';
import { POST } from '$routes/api/brand/approve/+server';
import { seed, truncate } from '../../../../../helpers/db';
import { USER_A, USER_B } from '../../../../../helpers/pipeline';

type Event = Parameters<typeof POST>[0];
const GUIDE = { statement: 'Plain titles.', keep: ['Song only'], fix: [], drop: [] };

const approve = (body: string, user: typeof USER_A | typeof USER_B = USER_A) =>
  POST({
    locals: { user },
    request: new Request('https://soundboard.test/api/brand/approve', { method: 'POST', body }),
  } as unknown as Event);

const has = async (slot: 'proposal' | 'approved') =>
  (await db().select().from(artistBrand).where(eq(artistBrand.slot, slot))).length > 0;

beforeEach(async () => {
  resetClients();
  await truncate();
  await seed({
    artistBrand: [
      {
        artistId: 'flr',
        slot: 'proposal',
        data: { ...GUIDE, status: 'PROPOSED', basedOn: ['v1'], createdAt: 1, approvedAt: null },
      },
    ],
  });
});

describe('POST /api/brand/approve', () => {
  it('404s for a user not linked to the artist and leaves the proposal', async () => {
    const error = await Promise.resolve()
      .then(() => approve(JSON.stringify({ ...GUIDE, proposedAt: 1 }), USER_B))
      .catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(await has('proposal')).toBe(true);
  });

  it('approves the posted guide', async () => {
    const response = await approve(JSON.stringify({ ...GUIDE, proposedAt: 1 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ approved: { ...GUIDE, status: 'APPROVED' } });
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

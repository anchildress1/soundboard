// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { artistMemory } from '#lib/server/core/schema.js';
import { POST } from '#src/routes/api/brand/discard/+server.js';
import { seed, truncate } from '../../../../../helpers/db';
import { USER_A, USER_B, USER_C, USERS } from '../../../../../helpers/pipeline';

type Event = Parameters<typeof POST>[0];
const discard = (user: typeof USER_A | typeof USER_B | typeof USER_C) =>
  POST({ locals: { user } } as unknown as Event);

const proposals = () => db().select().from(artistMemory);

beforeEach(async () => {
  resetClients();
  await truncate();
  await seed(USERS);
  await seed({
    artistMemory: [{ artistId: 'flr', kind: 'brand', key: 'proposal', data: { statement: 's' } }],
  });
});

describe('POST /api/brand/discard', () => {
  it.each([
    ['without a profile', USER_B],
    ['on a profile that is not curated', USER_C],
  ])('404s for a user %s and keeps the proposal', async (_label, user) => {
    const error = await Promise.resolve()
      .then(() => discard(user))
      .catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(await proposals()).toHaveLength(1);
  });

  it('drops the proposal', async () => {
    const response = await discard(USER_A);
    expect(await response.json()).toEqual({ proposal: null });
    expect(await proposals()).toEqual([]);
  });

  it('succeeds when there is nothing to discard', async () => {
    await truncate();
    expect((await discard(USER_A)).status).toBe(200);
  });
});

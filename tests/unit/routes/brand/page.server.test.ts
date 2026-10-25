// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { load } from '#src/routes/brand/+page.server.js';
import { seed, truncate } from '../../../helpers/db';
import { USER_A, USER_B, USER_C, USERS } from '../../../helpers/pipeline';

type Event = Parameters<typeof load>[0];
const run = (user: Event['locals']['user']) => load({ locals: { user } } as unknown as Event);

beforeEach(async () => {
  resetClients();
  await truncate();
  await seed(USERS);
});

describe('/brand load', () => {
  it.each([
    ['signed out', null],
    ['a user without a profile', USER_B],
    ['a profile that is not curated', USER_C],
  ])('404s when %s', async (_label, user) => {
    await seed({
      artistMemory: [{ artistId: 'flr', kind: 'brand', key: 'approved', data: { statement: 's' } }],
    });
    const error = await Promise.resolve()
      .then(() => run(user))
      .catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
  });

  it("returns the curated artist's approved guide and proposal, never another's", async () => {
    await seed({
      artistMemory: [{ artistId: 'flr', kind: 'brand', key: 'proposal', data: { statement: 'p' } }],
    });
    await seed({
      artistMemory: [
        { artistId: USER_C.artistId, kind: 'brand', key: 'approved', data: { statement: 'c' } },
      ],
    });
    expect(await run(USER_A)).toEqual({ approved: null, proposal: { statement: 'p' } });
  });
});

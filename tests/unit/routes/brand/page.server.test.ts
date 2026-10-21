// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { load } from '$routes/brand/+page.server';
import { seed, truncate } from '../../../helpers/db';
import { USER_A, USER_B } from '../../../helpers/pipeline';

type Event = Parameters<typeof load>[0];
const run = (user: Event['locals']['user']) => load({ locals: { user } } as unknown as Event);

beforeEach(async () => {
  resetClients();
  await truncate();
});

describe('/brand load', () => {
  it.each([
    ['signed out', null],
    ['an unlinked user', USER_B],
  ])('404s when %s', async (_label, user) => {
    await seed({
      artistMemory: [{ artistId: 'flr', kind: 'brand', key: 'approved', data: { statement: 's' } }],
    });
    const error = await Promise.resolve()
      .then(() => run(user))
      .catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
  });

  it("returns the artist's approved guide and proposal", async () => {
    await seed({
      artistMemory: [{ artistId: 'flr', kind: 'brand', key: 'proposal', data: { statement: 'p' } }],
    });
    expect(await run(USER_A)).toEqual({ approved: null, proposal: { statement: 'p' } });
  });
});

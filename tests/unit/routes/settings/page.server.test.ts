// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { load } from '#src/routes/settings/+page.server.js';
import { USER_A, USER_B } from '../../../helpers/pipeline';

type Event = Parameters<typeof load>[0];
const run = (user: Event['locals']['user']) => load({ locals: { user } } as unknown as Event);

describe('/settings load', () => {
  it.each([
    ['signed out', null],
    ['an unlinked user', USER_B],
  ])('404s when %s', async (_label, user) => {
    const error = await Promise.resolve()
      .then(() => run(user))
      .catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
  });

  it("opens for the artist's account", async () => {
    expect(await run(USER_A)).toEqual({});
  });
});

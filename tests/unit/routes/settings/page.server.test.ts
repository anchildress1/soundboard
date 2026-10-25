// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { load } from '#src/routes/settings/+page.server.js';
import { ARTIST_C, USER_A, USER_B, USER_C } from '../../../helpers/pipeline';

type Event = Parameters<typeof load>[0];
const run = (user: Event['locals']['user']) => load({ locals: { user } } as unknown as Event);

describe('/settings load', () => {
  it("returns the caller's own three editable fields, never the id or curated flag", async () => {
    expect(await run(USER_C)).toEqual({
      artist: {
        name: ARTIST_C.name,
        bandcampUrl: ARTIST_C.bandcampUrl,
        contactLine: ARTIST_C.contactLine,
      },
    });
  });

  it('returns only the signed-in user’s profile', async () => {
    const { artist } = (await run(USER_A)) as { artist: { name: string } };
    expect(artist.name).toBe(USER_A.artist.name);
    expect(JSON.stringify(artist)).not.toContain(ARTIST_C.name);
  });

  it.each([
    ['a user with no profile', USER_B],
    ['no user', null],
  ])('returns a null artist for %s', async (_label, user) => {
    expect(await run(user)).toEqual({ artist: null });
  });
});

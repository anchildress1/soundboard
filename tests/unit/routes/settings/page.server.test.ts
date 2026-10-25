// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_INFLUENCE, type Influence } from '#lib/influence.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { load } from '#src/routes/settings/+page.server.js';
import { seed, truncate } from '../../../helpers/db';
import {
  approvedGuide,
  ARTIST_C,
  pendingProposal,
  USER_A,
  USER_B,
  USER_C,
  USERS,
} from '../../../helpers/pipeline';

type Event = Parameters<typeof load>[0];
const run = (user: Event['locals']['user']) =>
  withIdentity(user?.uid, () => load({ locals: { user } } as unknown as Event));

const GUIDE = { statement: 'S.', keep: ['K'], fix: [], drop: [] };
const MINE: Influence = { sound: 0, feel: 2, wording: 3, discovery: 4, structure: 1 };
const C_FIELDS = {
  name: ARTIST_C.name,
  bandcampUrl: ARTIST_C.bandcampUrl,
  contactLine: ARTIST_C.contactLine,
};

beforeEach(async () => {
  await truncate();
  await seed(USERS);
});

describe('/settings load', () => {
  it("returns the caller's own three editable fields, never the id", async () => {
    expect(await run(USER_C)).toMatchObject({ artist: C_FIELDS });
  });

  it('returns only the signed-in user’s profile', async () => {
    const { artist } = (await run(USER_A)) as { artist: { name: string } };
    expect(artist.name).toBe(USER_A.artist.name);
    expect(JSON.stringify(artist)).not.toContain(ARTIST_C.name);
  });

  it.each([
    ['a user with no profile', USER_B],
    ['no user', null],
  ])('returns a null artist and the defaults for %s', async (_label, user) => {
    expect(await run(user)).toEqual({
      artist: null,
      influence: DEFAULT_INFLUENCE,
      saved: false,
      canSave: false,
    });
  });

  it('has the defaults, unsaved, and cannot save without an approved brand guide', async () => {
    await seed({ artistGuides: [pendingProposal(ARTIST_C.id, 'brand', GUIDE)] });
    expect(await run(USER_C)).toMatchObject({
      influence: DEFAULT_INFLUENCE,
      saved: false,
      canSave: false,
    });
  });

  it('can save once the brand guide is approved', async () => {
    await seed({ artistGuides: [approvedGuide(ARTIST_C.id, 'brand', GUIDE)] });
    expect(await run(USER_C)).toMatchObject({
      influence: DEFAULT_INFLUENCE,
      saved: false,
      canSave: true,
    });
  });

  it('returns saved settings', async () => {
    await seed({
      artistGuides: [{ ...approvedGuide(ARTIST_C.id, 'brand', GUIDE), influence: MINE }],
    });
    expect(await run(USER_C)).toMatchObject({ influence: MINE, saved: true, canSave: true });
  });

  it('never returns another artist’s settings', async () => {
    await seed({
      artistGuides: [{ ...approvedGuide(ARTIST_C.id, 'brand', GUIDE), influence: MINE }],
    });
    expect(await run(USER_A)).toMatchObject({ influence: DEFAULT_INFLUENCE, saved: false });
  });
});

// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import type { getGuides } from '#lib/server/artist/guides.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { load } from '#src/routes/brand/+page.server.js';
import { seed, truncate } from '../../../helpers/db';
import {
  approvedGuide,
  NATHAN_VOICE_RULES,
  pendingProposal,
  USER_A,
  USER_B,
  USER_C,
  USERS,
} from '../../../helpers/pipeline';

type Event = Parameters<typeof load>[0];
type User = Event['locals']['user'];
const run = (user: User) =>
  withIdentity(user?.uid, async () =>
    (load as unknown as (event: Event) => ReturnType<typeof getGuides>)({
      locals: { user },
    } as unknown as Event),
  );
const GUIDE = { statement: 's', keep: [], fix: [], drop: [] };

beforeEach(async () => {
  await truncate();
  await seed(USERS);
});

describe('/brand load', () => {
  it.each([
    ['signed out', null],
    ['a user without a profile', USER_B],
  ])('404s when %s', async (_label, user) => {
    const error = await run(user as User).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
  });

  it("opens for any profile, with only the caller's own guides", async () => {
    await seed({
      artistGuides: [
        approvedGuide(USER_C.artistId, 'brand', GUIDE),
        pendingProposal(USER_A.artistId, 'brand', GUIDE),
      ],
    });
    const data = await run(USER_C as User);
    expect(data.voice).toEqual({ approved: null, proposal: null, limitUntil: null });
    expect(data.brand).toMatchObject({ approved: { body: GUIDE }, proposal: null });
  });

  it('gives Nathan his carried-over voice and his pending brand proposal', async () => {
    await seed({ artistGuides: [pendingProposal(USER_A.artistId, 'brand', GUIDE)] });
    const data = await run(USER_A as User);
    expect(data.voice.approved).toMatchObject({
      body: { rules: NATHAN_VOICE_RULES },
      sources: { carriedOver: true },
    });
    expect(data.brand.proposal).toMatchObject({ body: GUIDE });
  });
});

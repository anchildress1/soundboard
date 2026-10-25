// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_INFLUENCE, INFLUENCE_ERROR, type Influence } from '#lib/influence.js';
import { NO_BRAND_GUIDE } from '#lib/server/artist/guides.js';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { artistGuides, jobs } from '#lib/server/core/schema.js';
import { PUT } from '#src/routes/api/influence/+server.js';
import { seed, truncate } from '../../../../helpers/db';
import {
  approvedGuide,
  ARTIST_C,
  C_JOB,
  seedJob,
  USER_A,
  USER_B,
  USER_C,
  USERS,
} from '../../../../helpers/pipeline';

type Event = Parameters<typeof PUT>[0];
type User = typeof USER_A | typeof USER_B | typeof USER_C | null;

const put = (body: unknown, user: User) =>
  withIdentity(user?.uid, async () =>
    PUT({
      request: new Request('http://localhost/api/influence', {
        method: 'PUT',
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      locals: { user },
    } as unknown as Event),
  );

const MINE: Influence = { sound: 0, feel: 2, wording: 3, discovery: 4, structure: 1 };
const GUIDE = { statement: 'S.', keep: ['K'], fix: [], drop: [] };
const stored = async () =>
  (await db().select().from(artistGuides).where(eq(artistGuides.artistId, ARTIST_C.id)))[0]!
    .influence;

beforeEach(async () => {
  await truncate();
  await seed({
    ...USERS,
    artistGuides: [...USERS.artistGuides, approvedGuide(ARTIST_C.id, 'brand', GUIDE)],
  });
});

describe('PUT /api/influence', () => {
  it('401s when signed out and writes nothing', async () => {
    const response = await put(MINE, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Sign in first.', fields: null });
    expect(await stored()).toBeNull();
  });

  it('404s a user with no artist profile', async () => {
    const rejected = await put(MINE, USER_B).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isHttpError(rejected) && rejected.status).toBe(404);
  });

  it('saves the settings on the approved brand guide and answers with them', async () => {
    const response = await put(MINE, USER_C);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ influence: MINE });
    expect(await stored()).toEqual(MINE);
  });

  it('saves again over an earlier save', async () => {
    await put(MINE, USER_C);
    await put(DEFAULT_INFLUENCE, USER_C);
    expect(await stored()).toEqual(DEFAULT_INFLUENCE);
  });

  it.each([
    ['a level above 4', { ...MINE, sound: 5 }],
    ['a level below 0', { ...MINE, sound: -1 }],
    ['a fractional level', { ...MINE, feel: 1.5 }],
    ['a level that is text', { ...MINE, wording: '2' }],
    ['a missing role', { sound: 1, feel: 1, wording: 1, discovery: 1 }],
    ['an extra key', { ...MINE, tone: 2 }],
  ])('422s %s and saves nothing', async (_label, body) => {
    const response = await put(body, USER_C);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: INFLUENCE_ERROR, fields: null });
    expect(await stored()).toBeNull();
  });

  it.each([
    ['text', 'nope'],
    ['an array', [1, 2, 3, 4, 5]],
  ])('400s a body that is %s', async (_label, body) => {
    expect((await put(body, USER_C)).status).toBe(400);
    expect(await stored()).toBeNull();
  });

  it('409s without an approved brand guide', async () => {
    await db().delete(artistGuides).where(eq(artistGuides.artistId, ARTIST_C.id));
    const response = await put(MINE, USER_C);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: NO_BRAND_GUIDE, fields: null });
  });

  it('never changes a stored pick or another artist’s settings', async () => {
    await seedJob({ id: 'jp', ...C_JOB });
    await db()
      .update(jobs)
      .set({ picks: [{ version: 1, influence: DEFAULT_INFLUENCE }] })
      .where(eq(jobs.id, 'jp'));
    await put(MINE, USER_C);
    const [job] = await db().select({ picks: jobs.picks }).from(jobs).where(eq(jobs.id, 'jp'));
    expect(job!.picks).toEqual([{ version: 1, influence: DEFAULT_INFLUENCE }]);
    const others = await db().select().from(artistGuides);
    expect(others.filter((row) => row.artistId !== ARTIST_C.id).map((r) => r.influence)).toEqual(
      others.filter((row) => row.artistId !== ARTIST_C.id).map(() => null),
    );
  });
});

// @vitest-environment node
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { artists, users } from '#lib/server/core/schema.js';
import { PUT } from '#src/routes/api/artist/+server.js';
import { seed, truncate } from '../../../../helpers/db';
import { ARTIST_C, USER_B, USER_C, USERS } from '../../../../helpers/pipeline';

type Event = Parameters<typeof PUT>[0];
type User = typeof USER_B | typeof USER_C | null;

// hooks.server.ts runs each request under the caller's identity; the handler relies on it for RLS.
const put = (body: unknown, user: User) =>
  withIdentity(user?.uid, async () =>
    PUT({
      request: new Request('http://localhost/api/artist', {
        method: 'PUT',
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      locals: { user },
    } as unknown as Event),
  );

const C_FORM = {
  name: ARTIST_C.name,
  bandcampUrl: ARTIST_C.bandcampUrl,
  contactLine: ARTIST_C.contactLine,
};
const storedC = async () =>
  (await db().select().from(artists).where(eq(artists.id, ARTIST_C.id)))[0]!;

beforeEach(async () => {
  await truncate();
  await seed(USERS);
});

describe('PUT /api/artist', () => {
  it('401s when signed out and writes nothing', async () => {
    const response = await put(C_FORM, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Sign in first.', fields: null });
  });

  it('creates the profile for a user with none, answering without id or curated', async () => {
    const response = await put({ name: 'B Band', bandcampUrl: '', contactLine: '' }, USER_B);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      artist: { name: 'B Band', bandcampUrl: null, contactLine: null },
    });
    const [link] = await db().select().from(users).where(eq(users.uid, USER_B.uid));
    expect(link!.artistId).not.toBeNull();
  });

  it("updates the caller's profile", async () => {
    const response = await put({ ...C_FORM, name: 'Renamed Band' }, USER_C);
    expect(await response.json()).toEqual({ artist: { ...C_FORM, name: 'Renamed Band' } });
    expect((await storedC()).name).toBe('Renamed Band');
  });

  it.each([
    ['name', { name: 'A, B' }, "Artist names can't contain commas."],
    ['bandcampUrl', { bandcampUrl: 'http://x' }, 'Use your https://<name>.bandcamp.com address.'],
    ['contactLine', { contactLine: 'DM #band' }, "Contact lines can't contain #."],
  ])(
    '422s a bad %s with its field message and leaves the row unchanged',
    async (key, patch, message) => {
      const before = await storedC();
      const response = await put({ ...C_FORM, ...patch }, USER_C);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: 'Fix the highlighted fields.',
        fields: { [key]: message },
      });
      expect(await storedC()).toEqual(before);
    },
  );

  it('ignores curated and id in the body', async () => {
    const response = await put({ ...C_FORM, curated: true, id: 'flr' }, USER_C);
    expect(response.status).toBe(200);
    expect(await storedC()).toMatchObject({ id: ARTIST_C.id, curated: false });
  });

  it('400s a body that is not JSON', async () => {
    expect((await put('nope', USER_C)).status).toBe(400);
  });
});

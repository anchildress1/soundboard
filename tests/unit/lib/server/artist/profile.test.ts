// @vitest-environment node
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { ActionError } from '#lib/server/core/errors.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { artists, users } from '#lib/server/core/schema.js';
import {
  artistProfile,
  createArtist,
  requireArtist,
  saveArtist,
  updateArtist,
} from '#lib/server/artist/profile.js';
import { seed, truncate } from '../../../../helpers/db';
import { ARTIST_C, USER_A, USER_B, USER_C, USERS } from '../../../../helpers/pipeline';

const as = <T>(uid: string, operation: () => Promise<T>) => withIdentity(uid, operation);
const row = async (id: string) => (await db().select().from(artists).where(eq(artists.id, id)))[0];
const linkOf = async (uid: string) =>
  (await db().select({ artistId: users.artistId }).from(users).where(eq(users.uid, uid)))[0]!
    .artistId;

/** The Postgres error Drizzle wraps. */
const pgError = (error: unknown) => {
  const { code, message } = (error as { cause: { code: string; message: string } }).cause;
  return { code, message };
};

const B_BAND = { name: 'B Band', bandcampUrl: '', contactLine: '' };

beforeEach(async () => {
  await truncate();
  await seed(USERS);
});

describe('artistProfile', () => {
  it("returns the user's linked profile", async () => {
    expect(await as(USER_C.uid, () => artistProfile(USER_C.uid))).toEqual(ARTIST_C);
  });

  it('returns null with no link', async () => {
    expect(await as(USER_B.uid, () => artistProfile(USER_B.uid))).toBeNull();
  });

  it("never returns another user's profile through RLS", async () => {
    expect(await as(USER_B.uid, () => artistProfile(USER_C.uid))).toBeNull();
  });
});

describe('saveArtist', () => {
  it('creates a profile and links it to the caller', async () => {
    const saved = await as(USER_B.uid, () => saveArtist(USER_B, B_BAND));
    expect(saved).toMatchObject({
      name: 'B Band',
      bandcampUrl: null,
      contactLine: null,
    });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await linkOf(USER_B.uid)).toBe(saved.id);
  });

  it("updates the caller's own profile, normalizing the Bandcamp URL", async () => {
    const saved = await as(USER_C.uid, () =>
      saveArtist(USER_C, {
        name: 'Renamed Band',
        bandcampUrl: 'https://Renamed.Bandcamp.com/',
        contactLine: ARTIST_C.contactLine,
      }),
    );
    expect(saved).toEqual({
      ...ARTIST_C,
      name: 'Renamed Band',
      bandcampUrl: 'https://renamed.bandcamp.com',
    });
    expect(await row(ARTIST_C.id)).toMatchObject({ name: 'Renamed Band' });
  });

  it('clears an emptied contact line to null', async () => {
    await as(USER_C.uid, () => saveArtist(USER_C, { ...ARTIST_C, contactLine: '' }));
    expect((await row(ARTIST_C.id))!.contactLine).toBeNull();
  });

  it('turns a create that lost a race with another tab into an update', async () => {
    await as(USER_B.uid, () => saveArtist(USER_B, B_BAND));
    // The second tab still holds the session from before the first save.
    const second = await as(USER_B.uid, () =>
      saveArtist(USER_B, { ...B_BAND, name: 'B Band Two' }),
    );
    expect(second.name).toBe('B Band Two');
    expect(
      (await db().select().from(artists)).filter((a) => a.name.startsWith('B Band')),
    ).toHaveLength(1);
    expect(await linkOf(USER_B.uid)).toBe(second.id);
  });

  it('refuses invalid input with field errors and leaves the stored row as it was', async () => {
    const before = await row(ARTIST_C.id);
    const error = await as(USER_C.uid, () =>
      saveArtist(USER_C, { name: '', bandcampUrl: 'http://x', contactLine: '' }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect(error).toMatchObject({
      status: 422,
      message: 'Fix the highlighted fields.',
      fields: {
        name: 'Add the artist name.',
        bandcampUrl: 'Use your https://<name>.bandcamp.com address.',
      },
    });
    expect(await row(ARTIST_C.id)).toEqual(before);
  });

  it('lets two users save the same name', async () => {
    const b = await as(USER_B.uid, () => saveArtist(USER_B, { ...B_BAND, name: ARTIST_C.name }));
    expect(b.name).toBe(ARTIST_C.name);
    expect(b.id).not.toBe(ARTIST_C.id);
  });

  it('409s when the session names a profile the caller no longer holds', async () => {
    const stale = { uid: USER_B.uid, artist: { ...ARTIST_C } };
    const error = await as(USER_B.uid, () => saveArtist(stale, B_BAND)).catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: 409,
      message: 'Your artist profile changed. Reload and try again.',
    });
    expect((await row(ARTIST_C.id))!.name).toBe(ARTIST_C.name);
  });
});

describe('updateArtist', () => {
  it("changes no row of another user's profile", async () => {
    expect(
      await as(USER_A.uid, () =>
        updateArtist(ARTIST_C.id, { name: 'Taken', bandcampUrl: null, contactLine: null }),
      ),
    ).toBeNull();
    expect((await row(ARTIST_C.id))!.name).toBe(ARTIST_C.name);
  });

  it('sets updated_at', async () => {
    const before = (await row(ARTIST_C.id))!.updatedAt;
    await as(USER_C.uid, () =>
      updateArtist(ARTIST_C.id, { name: 'Later', bandcampUrl: null, contactLine: null }),
    );
    expect((await row(ARTIST_C.id))!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});

describe('createArtist', () => {
  it('raises 23505 for a caller who already has a profile', async () => {
    const error = await as(USER_C.uid, () =>
      createArtist({ name: 'Second', bandcampUrl: null, contactLine: null }),
    ).catch((e: unknown) => e);
    expect(pgError(error)).toEqual({ code: '23505', message: 'Artist profile exists' });
  });

  it('raises 42501 for a caller who is not an active user', async () => {
    const error = await as('ghost', () =>
      createArtist({ name: 'Ghost', bandcampUrl: null, contactLine: null }),
    ).catch((e: unknown) => e);
    expect(pgError(error)).toEqual({ code: '42501', message: 'Verified identity required' });
  });
});

describe('requireArtist', () => {
  it("returns the signed-in user's profile id", () => {
    expect(requireArtist(USER_C)).toBe(ARTIST_C.id);
  });

  it.each([
    ['signed out', null],
    ['without a profile', USER_B],
  ])('404s when %s, never 403', (_, user) => {
    expect(() => requireArtist(user)).toThrow(expect.objectContaining({ status: 404 }));
  });
});

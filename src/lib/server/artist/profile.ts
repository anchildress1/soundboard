import { error } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { parseArtist, type ArtistValue } from '#lib/artist.js';
import { ActionError, pgCode } from '#lib/server/core/errors.js';
import { query, type Database, type Tx } from '#lib/server/core/db.js';
import { artists, users } from '#lib/server/core/schema.js';

/** The user's own artist profile. */
export type ArtistProfile = {
  id: string;
  name: string;
  bandcampUrl: string | null;
  contactLine: string | null;
};

const PROFILE = {
  id: artists.id,
  name: artists.name,
  bandcampUrl: artists.bandcampUrl,
  contactLine: artists.contactLine,
};

/** The profile linked to `uid`, or null when the user has none; pass `q` to read in a transaction. */
export async function artistProfile(uid: string, q?: Database | Tx): Promise<ArtistProfile | null> {
  if (!q) return await query((tx) => artistProfile(uid, tx));
  const [row] = await q
    .select(PROFILE)
    .from(users)
    .innerJoin(artists, eq(artists.id, users.artistId))
    .where(eq(users.uid, uid));
  return row ?? null;
}

/** Claims a new profile for the signed-in caller; Postgres raises `23505` when one is linked. */
export async function createArtist(value: ArtistValue): Promise<ArtistProfile> {
  return await query(async (tx) => {
    const result = (await tx.execute(sql`select id, name, bandcamp_url as "bandcampUrl",
      contact_line as "contactLine"
      from public.soundboard_create_artist(${value.name}, ${value.bandcampUrl}, ${value.contactLine})`)) as {
      rows: ArtistProfile[];
    };
    return result.rows[0]!;
  });
}

/** Edits the caller's own profile through RLS; null when `artistId` isn't theirs. */
export async function updateArtist(
  artistId: string,
  value: ArtistValue,
): Promise<ArtistProfile | null> {
  const [row] = await query((tx) =>
    tx
      .update(artists)
      .set({ ...value, updatedAt: new Date() })
      .where(eq(artists.id, artistId))
      .returning(PROFILE),
  );
  return row ?? null;
}

/**
 * Creates the caller's profile, or updates the one they have. A create that races another tab's
 * gets `23505` and becomes an update. Invalid input is a 422 and writes nothing.
 */
export async function saveArtist(
  user: { uid: string; artist: ArtistProfile | null },
  input: unknown,
): Promise<ArtistProfile> {
  const parsed = parseArtist(input);
  if ('errors' in parsed) throw new ActionError(422, 'Fix the highlighted fields.', parsed.errors);
  let artistId = user.artist?.id;
  if (!artistId) {
    try {
      return await createArtist(parsed.value);
    } catch (error_) {
      if (pgCode(error_) !== '23505') throw error_;
    }
    artistId = (await artistProfile(user.uid))?.id;
  }
  const saved = artistId ? await updateArtist(artistId, parsed.value) : null;
  if (!saved) throw new ActionError(409, 'Your artist profile changed. Reload and try again.');
  return saved;
}

/** The caller's artist ID, or the same 404 as a missing page when they have no profile. */
export function requireArtist(user: { artist: ArtistProfile | null } | null): string {
  if (!user?.artist) error(404, 'Not found');
  return user.artist.id;
}

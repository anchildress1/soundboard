import { eq, sql } from 'drizzle-orm';
import { parseArtist, type ArtistValue } from '#lib/artist.js';
import { ActionError } from '#lib/server/core/errors.js';
import { query, type Database, type Tx } from '#lib/server/core/db.js';
import { artists, users } from '#lib/server/core/schema.js';

/** The user's own artist profile. `curated` selects Nathan's voice and brand guide (spec 005 drops it). */
export type ArtistProfile = {
  id: string;
  name: string;
  bandcampUrl: string | null;
  contactLine: string | null;
  curated: boolean;
};

const PROFILE = {
  id: artists.id,
  name: artists.name,
  bandcampUrl: artists.bandcampUrl,
  contactLine: artists.contactLine,
  curated: artists.curated,
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
      contact_line as "contactLine", curated
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

/** The Postgres error code, which Drizzle keeps on the wrapped driver error. */
const pgCode = (error: unknown): unknown => {
  const { code, cause } = (error ?? {}) as { code?: unknown; cause?: { code?: unknown } };
  return code ?? cause?.code;
};

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
    } catch (error) {
      if (pgCode(error) !== '23505') throw error;
    }
    artistId = (await artistProfile(user.uid))?.id;
  }
  const saved = artistId ? await updateArtist(artistId, parsed.value) : null;
  if (!saved) throw new ActionError(409, 'Your artist profile changed. Reload and try again.');
  return saved;
}

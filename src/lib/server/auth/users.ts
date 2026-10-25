import { and, eq, sql } from 'drizzle-orm';
import { query } from '#lib/server/core/db.js';
import { signupMode } from '#lib/server/core/env.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { artists, users } from '#lib/server/core/schema.js';
import type { ArtistProfile } from '#lib/server/artist/profile.js';

/** A user who has signed in: `uid` is bound. */
export type User = Omit<typeof users.$inferSelect, 'uid'> & { uid: string };

/** The active user bound to `uid` with their artist profile, or null when there is none or it was deactivated. */
export async function getUser(
  uid: string,
): Promise<(User & { artist: ArtistProfile | null }) | null> {
  const [row] = await query((tx) =>
    tx
      .select({
        user: users,
        artist: {
          id: artists.id,
          name: artists.name,
          bandcampUrl: artists.bandcampUrl,
          contactLine: artists.contactLine,
          curated: artists.curated,
        },
      })
      .from(users)
      .leftJoin(artists, eq(artists.id, users.artistId))
      .where(and(eq(users.uid, uid), eq(users.active, true))),
  );
  return row ? { ...(row.user as User), artist: row.artist } : null;
}

const normalize = (email: string) => email.trim().toLowerCase();

/**
 * Admits a verified Google account. A bound account signs in by `uid` while active, so an email
 * change keeps access; a first sign-in binds the active, unbound row for the token's email. Open signup also
 * creates a row for an unknown email. Returns `denied`, writing nothing, otherwise.
 */
export async function admit(sub: string, email: string): Promise<User | 'denied'> {
  const open = signupMode() === 'open';
  return await withIdentity(sub, () =>
    query(async (tx) => {
      const result = (await tx.execute(sql`select email, uid, artist_id as "artistId", active,
      created_at as "createdAt" from public.soundboard_admit(${sub}, ${normalize(email)}, ${open})`)) as {
        rows: (Omit<User, 'createdAt'> & { createdAt: Date | string })[];
      };
      const row = result.rows[0];
      return row ? { ...row, createdAt: new Date(row.createdAt) } : 'denied';
    }),
  );
}

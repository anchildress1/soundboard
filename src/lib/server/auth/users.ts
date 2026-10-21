import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '$lib/server/core/db';
import { signupMode } from '$lib/server/core/env';
import { users } from '$lib/server/core/schema';

/** A user who has signed in: `uid` is bound. */
export type User = Omit<typeof users.$inferSelect, 'uid'> & { uid: string };

/** The active user bound to `uid`, or null when there is none or it was deactivated. */
export async function getUser(uid: string): Promise<User | null> {
  const [user] = await db()
    .select()
    .from(users)
    .where(and(eq(users.uid, uid), eq(users.active, true)));
  return (user as User | undefined) ?? null;
}

const normalize = (email: string) => email.trim().toLowerCase();

/**
 * Admits a verified Google account. A bound account signs in by `uid` while active, so an email
 * change keeps access; a first sign-in binds the active, unbound row for the token's email. Open signup also
 * creates a row for an unknown email. Returns `denied`, writing nothing, otherwise.
 */
export async function admit(sub: string, email: string): Promise<User | 'denied'> {
  // A bound account is decided by its own row: a revoked one can't bind another email instead.
  const [bound] = await db().select().from(users).where(eq(users.uid, sub));
  if (bound) return bound.active ? (bound as User) : 'denied';
  const address = normalize(email);
  if (signupMode() === 'open') {
    await db().insert(users).values({ email: address }).onConflictDoNothing();
  }
  // `or uid = sub` lets a concurrent first sign-in of the same account through after the lock.
  const [claimed] = await db()
    .update(users)
    .set({ uid: sub })
    .where(
      and(
        eq(users.email, address),
        eq(users.active, true),
        or(isNull(users.uid), eq(users.uid, sub)),
      ),
    )
    .returning();
  return (claimed as User | undefined) ?? 'denied';
}

import { and, eq, isNull, or } from 'drizzle-orm';
import { db, type Tx } from '$lib/server/core/db';
import { signupMode } from '$lib/server/core/env';
import { invites, users } from '$lib/server/core/schema';

export type User = typeof users.$inferSelect;

export async function getUser(uid: string): Promise<User | null> {
  const [user] = await db().select().from(users).where(eq(users.uid, uid));
  return user ?? null;
}

/**
 * Refreshes an existing user's email and name, returning its current row or null if absent.
 */
export async function updateProfile(
  uid: string,
  profile: { email: string; name: string | null },
): Promise<User | null> {
  const [user] = await db()
    .update(users)
    .set({ email: profile.email, name: profile.name })
    .where(eq(users.uid, uid))
    .returning();
  return user ?? null;
}

const normalize = (email: string) => email.trim().toLowerCase();

/**
 * Creates the user, or returns the one a concurrent first sign-in of the same account created
 * between this transaction's read and its insert.
 */
async function createUser(tx: Tx, row: typeof users.$inferInsert): Promise<User> {
  const [created] = await tx.insert(users).values(row).onConflictDoNothing().returning();
  if (created) return created;
  const [raced] = await tx.select().from(users).where(eq(users.uid, row.uid));
  return raced!;
}

/**
 * Admits a verified Google account, creating its user on first sign-in. In invite mode, a returning
 * user is checked against the invite they redeemed, so an email change keeps access; a first
 * sign-in binds the invite for the token's email to this `sub`. Returns `denied`, writing nothing,
 * for a missing, inactive or foreign-bound invite.
 */
export async function redeemInvite(sub: string, email: string): Promise<User | 'denied'> {
  const mode = signupMode();
  return db().transaction(async (tx) => {
    const [existing] = await tx.select().from(users).where(eq(users.uid, sub));
    if (mode === 'open') {
      if (existing) return existing;
      return createUser(tx, {
        uid: sub,
        email,
        inviteEmail: null,
        artistId: null,
        accessGeneration: 1,
      });
    }

    const inviteEmail = existing ? existing.inviteEmail : normalize(email);
    // A user created under open signup has no invite to fall back on.
    if (inviteEmail === null) return 'denied';
    const [invite] = await tx
      .update(invites)
      .set({ boundSub: sub })
      .where(
        and(
          eq(invites.email, inviteEmail),
          eq(invites.active, true),
          or(isNull(invites.boundSub), eq(invites.boundSub, sub)),
        ),
      )
      .returning({ artistId: invites.artistId });
    if (!invite) return 'denied';
    if (existing) return existing;
    return createUser(tx, {
      uid: sub,
      email,
      inviteEmail,
      artistId: invite.artistId,
      accessGeneration: 1,
    });
  });
}

import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '$lib/server/core/db';
import { signupMode } from '$lib/server/core/env';
import { invites, users } from '$lib/server/core/schema';

export type User = typeof users.$inferSelect;

export async function getUser(uid: string): Promise<User | null> {
  const [user] = await db().select().from(users).where(eq(users.uid, uid));
  return user ?? null;
}

/**
 * Refreshes an existing user's email and name from their latest ID token. Never inserts (only
 * `redeemInvite` creates users) and never writes `accessGeneration`, so a sign-in can't revive a
 * revoked session. Returns null when the user doesn't exist.
 */
export async function upsertUser(
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
      const [user] = await tx
        .insert(users)
        .values({ uid: sub, email, inviteEmail: null, artistId: null, accessGeneration: 1 })
        .returning();
      return user!;
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

    const [user] = await tx
      .insert(users)
      .values({ uid: sub, email, inviteEmail, artistId: invite.artistId, accessGeneration: 1 })
      .returning();
    return user!;
  });
}

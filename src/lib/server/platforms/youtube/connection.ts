import { and, eq } from 'drizzle-orm';
import { OAuth2Client } from 'google-auth-library';
import { db } from '$lib/server/core/db';
import { required } from '$lib/server/core/env';
import { decrypt } from '$lib/server/core/kms';
import { connections } from '$lib/server/core/schema';

export type ConnectionStatus = 'connected' | 'missing_scopes' | 'no_channel' | 'revoked';
export type Connection = typeof connections.$inferSelect;

/** Everything a (re)connect writes. `tokenCiphertext` must be null unless `connected`. */
export type ConnectionRow = {
  status: ConnectionStatus;
  channelId: string | null;
  channelTitle: string | null;
  scopes: string[];
  tokenCiphertext: string | null;
};

const PLATFORM = 'youtube';
const mine = (uid: string) => and(eq(connections.uid, uid), eq(connections.platform, PLATFORM));

export async function getConnection(uid: string): Promise<Connection | null> {
  const [row] = await db().select().from(connections).where(mine(uid));
  return row ?? null;
}

/** Writes the user's whole connection in one upsert, so a reconnect never leaves a mixed row. */
export async function putConnection(uid: string, row: ConnectionRow): Promise<void> {
  const values = { ...row, updatedAt: new Date() };
  await db()
    .insert(connections)
    .values({ uid, platform: PLATFORM, ...values })
    .onConflictDoUpdate({ target: [connections.uid, connections.platform], set: values });
}

export async function deleteConnection(uid: string): Promise<void> {
  await db().delete(connections).where(mine(uid));
}

/**
 * Marks the grant revoked and drops its token in the same write; a dead token is never kept. With
 * `tokenCiphertext`, only that grant is revoked, so a reconnect that lands mid-refresh survives.
 */
export async function markRevoked(uid: string, tokenCiphertext?: string): Promise<void> {
  const grant = tokenCiphertext ? eq(connections.tokenCiphertext, tokenCiphertext) : undefined;
  await db()
    .update(connections)
    .set({ status: 'revoked', tokenCiphertext: null, updatedAt: new Date() })
    .where(and(mine(uid), grant));
}

// Read from the response body: the library rewrites the message for reauth-required grants.
const revoked = (error: unknown) =>
  (error as { response?: { data?: { error?: string } } }).response?.data?.error === 'invalid_grant';

/**
 * A fresh access token for the user's grant on `channelId`, or null unless the connection is
 * `connected` to that channel. Google rejecting the refresh token marks the connection revoked.
 */
export async function accessTokenFor(uid: string, channelId: string): Promise<string | null> {
  const connection = await getConnection(uid);
  if (connection?.status !== 'connected' || connection.channelId !== channelId) return null;
  const cipher = connection.tokenCiphertext;
  if (!cipher) return null;
  const client = new OAuth2Client({
    clientId: required('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
  });
  client.setCredentials({ refresh_token: await decrypt(cipher) });
  try {
    const { token } = await client.getAccessToken();
    return token ?? null;
  } catch (error) {
    if (!revoked(error)) throw error;
    await markRevoked(uid, cipher);
    return null;
  }
}

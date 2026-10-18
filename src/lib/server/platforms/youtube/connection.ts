import { captureMessage } from '@sentry/sveltekit';
import { and, eq } from 'drizzle-orm';
import { OAuth2Client } from 'google-auth-library';
import { db, type Database, type Tx } from '$lib/server/core/db';
import { required } from '$lib/server/core/env';
import { invalidGrant } from '$lib/server/core/errors';
import { decrypt, encrypt } from '$lib/server/core/kms';
import { connections } from '$lib/server/core/schema';
import { channelsMine, YOUTUBE_SCOPES } from './youtube';

type Stored = typeof connections.$inferSelect;

/** A connection's own fields. Only a `connected` row holds a token, and it always names a channel. */
export type ConnectionRow =
  | {
      status: 'connected';
      channelId: string;
      channelTitle: string | null;
      scopes: string[];
      tokenCiphertext: string;
    }
  | {
      status: Exclude<Stored['status'], 'connected'>;
      channelId: string | null;
      channelTitle: string | null;
      scopes: string[];
      tokenCiphertext: null;
    };

export type Connection = ConnectionRow & Pick<Stored, 'uid' | 'platform' | 'updatedAt'>;
export type ConnectionStatus = Connection['status'];

const PLATFORM = 'youtube';
const mine = (uid: string) => and(eq(connections.uid, uid), eq(connections.platform, PLATFORM));

/** The user's YouTube connection; pass a transaction to read it where it is used. */
export async function getConnection(
  uid: string,
  q: Database | Tx = db(),
): Promise<Connection | null> {
  const [row] = await q.select().from(connections).where(mine(uid));
  // The table's check constraints hold the union's shape.
  return (row as Connection | undefined) ?? null;
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
 * Marks the grant `tokenCiphertext` revoked and drops its token in the same write; a dead token is
 * never kept. A newer grant from a reconnect that landed mid-refresh is left alone.
 */
export async function markRevoked(uid: string, tokenCiphertext: string): Promise<void> {
  await db()
    .update(connections)
    .set({ status: 'revoked', tokenCiphertext: null, updatedAt: new Date() })
    .where(and(mine(uid), eq(connections.tokenCiphertext, tokenCiphertext)));
}

/**
 * A fresh access token for the user's grant on `channelId`, or null while the user isn't connected.
 * Google rejecting the refresh token marks the connection revoked and returns null. Throws when the
 * connected channel isn't `channelId`, and on any other failure.
 */
export async function accessTokenFor(uid: string, channelId: string): Promise<string | null> {
  const connection = await getConnection(uid);
  if (connection?.status !== 'connected') return null;
  // The channel lock means a reconnect can't bring the job's channel back, so this never waits.
  if (connection.channelId !== channelId)
    throw new Error("Connected channel doesn't match this job's channel.");
  const cipher = connection.tokenCiphertext;
  const refreshToken = await decrypt(cipher).catch((cause: unknown) => {
    throw new Error("Couldn't unlock the YouTube grant.", { cause });
  });
  const client = new OAuth2Client({
    clientId: required('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
  });
  client.setCredentials({ refresh_token: refreshToken });
  let token: string | null | undefined;
  try {
    ({ token } = await client.getAccessToken());
  } catch (error) {
    if (!invalidGrant(error))
      throw new Error("Couldn't refresh the YouTube grant.", { cause: error });
    captureMessage('YouTube grant revoked', { level: 'info' });
    await markRevoked(uid, cipher);
    return null;
  }
  if (!token) throw new Error('Google refreshed the YouTube grant without an access token.');
  return token;
}

/** The parts of a fresh Google grant a connection needs. */
export type ConnectionGrant = {
  scopes: string[];
  refreshToken: string | null;
  accessToken: string;
};

/** What a fresh grant made of the connection; `consent` needs the forced-consent connect. */
export type ConnectOutcome = 'connected' | 'missing_scopes' | 'no_channel' | 'consent';

/**
 * Evaluates a fresh grant for the user's YouTube connection and writes it in at most one upsert.
 * A failed grant never touches a `connected` row, so a sign-in never erases a working connection;
 * the grant's own outcome is still returned. Returns `consent` on a sign-in that brought no refresh
 * token and has no stored grant to fall back on: only a forced-consent connect can finish it.
 */
export async function connectGrant(
  uid: string,
  grant: ConnectionGrant,
  purpose: 'sign-in' | 'connect',
): Promise<ConnectOutcome> {
  const stored = await getConnection(uid);
  const kept = stored?.status === 'connected';
  const fail = async (status: 'missing_scopes' | 'no_channel') => {
    if (!kept) {
      await putConnection(uid, {
        status,
        channelId: null,
        channelTitle: null,
        scopes: grant.scopes,
        tokenCiphertext: null,
      });
    }
    return status;
  };

  // Read-only, upload-only and identity-only grants all fail here.
  if (!YOUTUBE_SCOPES.every((scope) => grant.scopes.includes(scope))) return fail('missing_scopes');
  const channel = await channelsMine(grant.accessToken);
  if (!channel) return fail('no_channel');
  if (grant.refreshToken) {
    await putConnection(uid, {
      status: 'connected',
      channelId: channel.id,
      channelTitle: channel.title,
      scopes: grant.scopes,
      tokenCiphertext: await encrypt(grant.refreshToken),
    });
    return 'connected';
  }
  if (kept && stored.channelId === channel.id) return 'connected';
  // Google only returns a refresh token on consent, so an account that granted this client before
  // (or a revoked one) needs the forced-consent connect.
  if (!kept && purpose === 'sign-in') return 'consent';
  return fail('missing_scopes');
}

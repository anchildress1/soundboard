import { captureException, captureMessage } from '@sentry/sveltekit';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { OAuth2Client } from 'google-auth-library';
import { query, type Database, type Tx } from '#lib/server/core/db.js';
import { required } from '#lib/server/core/env.js';
import { invalidGrant } from '#lib/server/core/errors.js';
import { decrypt, encrypt } from '#lib/server/core/kms.js';
import { connections } from '#lib/server/core/schema.js';
import { channelsMine, YOUTUBE_SCOPES } from './youtube';

type Stored = typeof connections.$inferSelect;

/**
 * A connection's own fields. Only a `connected` row holds a token, and it always names a channel.
 */
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

export type Connection = ConnectionRow & Pick<Stored, 'uid' | 'updatedAt'>;
export type ConnectionStatus = Connection['status'];

const mine = (uid: string) => eq(connections.uid, uid);

/** The user's YouTube connection; pass `q` to read it inside the caller's transaction. */
export async function getConnection(uid: string, q?: Database | Tx): Promise<Connection | null> {
  if (!q) return await query((tx) => getConnection(uid, tx));
  const [row] = await q.select().from(connections).where(mine(uid));
  // The table's check constraints hold the union's shape.
  return (row as Connection | undefined) ?? null;
}

/**
 * Writes the user's whole connection in one upsert. A failed status never replaces a `connected`
 * row, even one a concurrent connect wrote after this caller read it.
 */
export async function putConnection(uid: string, row: ConnectionRow): Promise<void> {
  const values = { ...row, updatedAt: new Date() };
  await query((tx) =>
    tx
      .insert(connections)
      .values({ uid, ...values })
      .onConflictDoUpdate({
        target: connections.uid,
        set: values,
        setWhere: row.status === 'connected' ? undefined : ne(connections.status, 'connected'),
      }),
  );
}

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** Revokes a stored grant at Google; false, and reported, when Google didn't confirm it. */
async function revokeAtGoogle(tokenCiphertext: string): Promise<boolean> {
  try {
    const response = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: await decrypt(tokenCiphertext) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return true;
    captureMessage('YouTube revoke refused', {
      level: 'warning',
      tags: { status: response.status },
    });
  } catch (error) {
    captureException(error, { tags: { component: 'youtube-revoke' } });
  }
  return false;
}

/**
 * Disconnects YouTube: revokes the stored grant at Google, then deletes the row unless a reconnect
 * replaced its grant meanwhile. A failed revoke is reported and the row is deleted anyway, so the
 * revoked token is never kept. Returns whether Google confirmed the revoke; true when there was no
 * token to revoke.
 */
export async function revokeGrant(uid: string): Promise<boolean> {
  const connection = await getConnection(uid);
  if (!connection) return true;
  const { tokenCiphertext } = connection;
  const revoked = tokenCiphertext ? await revokeAtGoogle(tokenCiphertext) : true;
  // A reconnect from another tab can land while Google answers; its new grant stays. A tokenless
  // row holds no grant, so a step that marked it revoked meanwhile doesn't keep it.
  const tokenless = isNull(connections.tokenCiphertext);
  const observed = tokenCiphertext
    ? or(eq(connections.tokenCiphertext, tokenCiphertext), tokenless)
    : tokenless;
  await query((tx) => tx.delete(connections).where(and(mine(uid), observed)));
  return revoked;
}

/**
 * Marks the grant stored as `tokenCiphertext` revoked, dropping its token in the same write; a
 * dead token is never kept. A newer grant from a reconnect that landed mid-refresh is left alone.
 */
export async function markRevoked(uid: string, tokenCiphertext: string): Promise<void> {
  await query((tx) =>
    tx
      .update(connections)
      .set({ status: 'revoked', tokenCiphertext: null, updatedAt: new Date() })
      .where(and(mine(uid), eq(connections.tokenCiphertext, tokenCiphertext))),
  );
}

/**
 * A fresh access token, and how to give up its grant once YouTube refuses the token. `refused`
 * never throws: a failed write is reported, so the caller still answers with its reconnect wait.
 */
export type Access = { token: string; refused: (jobId: string) => Promise<void> };

/**
 * A fresh access token for the user's grant on `channelId`, or null while the user isn't connected.
 * Google rejecting the refresh token marks the connection revoked and returns null. Throws when the
 * connected channel isn't `channelId`, and on any other failure.
 */
export async function accessTokenFor(uid: string, channelId: string): Promise<Access | null> {
  const connection = await getConnection(uid);
  if (connection?.status !== 'connected') return null;
  // The channel lock means a reconnect can't bring the job's channel back, so this throws rather
  // than returning null.
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
  return {
    token,
    refused: async (jobId) => {
      const tags = { 'job.id': jobId };
      captureMessage('YouTube refused the grant', { level: 'warning', tags });
      try {
        await markRevoked(uid, cipher);
      } catch (error) {
        captureException(error, { tags: { ...tags, component: 'youtube-revoke-mark' } });
      }
    },
  };
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
    await putConnection(uid, {
      status,
      channelId: null,
      channelTitle: null,
      scopes: grant.scopes,
      tokenCiphertext: null,
    });
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

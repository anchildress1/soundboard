import { OAuth2Client } from 'google-auth-library';
import { secretManager } from '$lib/server/core/clients';
import { required } from '$lib/server/core/env';

export type UploadChannel = 'nathan' | 'sandbox';

const NOT_FOUND = 5;

const secretId = (channel: UploadChannel) => `yt-refresh-${channel}`;
const parent = () => `projects/${required('GCP_PROJECT_ID')}`;

/** The channel's YouTube refresh token from Secret Manager, or null before it is connected. */
export async function getRefreshToken(channel: UploadChannel): Promise<string | null> {
  try {
    const [version] = await secretManager().accessSecretVersion({
      name: `${parent()}/secrets/${secretId(channel)}/versions/latest`,
    });
    return version.payload?.data ? Buffer.from(version.payload.data).toString('utf8') : null;
  } catch (error) {
    if ((error as { code?: number }).code === NOT_FOUND) return null;
    throw error;
  }
}

/** Adds a new secret version, creating the secret on first connect. */
export async function storeRefreshToken(channel: UploadChannel, token: string): Promise<void> {
  const client = secretManager();
  const name = `${parent()}/secrets/${secretId(channel)}`;
  const add = () =>
    client.addSecretVersion({ parent: name, payload: { data: Buffer.from(token, 'utf8') } });
  try {
    await add();
  } catch (error) {
    if ((error as { code?: number }).code !== NOT_FOUND) throw error;
    await client.createSecret({
      parent: parent(),
      secretId: secretId(channel),
      secret: { replication: { automatic: {} } },
    });
    await add();
  }
}

// Read from the response body: the library rewrites the message for reauth-required grants.
const revoked = (error: unknown) =>
  (error as { response?: { data?: { error?: string } } }).response?.data?.error === 'invalid_grant';

/**
 * A fresh access token for the channel, or null when no refresh token is stored or Google has
 * revoked or expired it; either way the channel must be connected again.
 */
export async function accessToken(channel: UploadChannel): Promise<string | null> {
  const refreshToken = await getRefreshToken(channel);
  if (!refreshToken) return null;
  const client = new OAuth2Client({
    clientId: required('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
  });
  client.setCredentials({ refresh_token: refreshToken });
  try {
    const { token } = await client.getAccessToken();
    return token ?? null;
  } catch (error) {
    if (revoked(error)) return null;
    throw error;
  }
}

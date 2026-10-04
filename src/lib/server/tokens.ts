import { OAuth2Client } from 'google-auth-library';
import { secretManager } from './clients';
import { required } from './env';

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

/** A fresh access token for the channel, or null when no refresh token is stored. */
export async function accessToken(channel: UploadChannel): Promise<string | null> {
  const refreshToken = await getRefreshToken(channel);
  if (!refreshToken) return null;
  const client = new OAuth2Client({
    clientId: required('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
  });
  client.setCredentials({ refresh_token: refreshToken });
  const { token } = await client.getAccessToken();
  return token ?? null;
}

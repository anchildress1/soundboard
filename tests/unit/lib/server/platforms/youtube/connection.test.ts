// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import {
  accessTokenFor,
  deleteConnection,
  getConnection,
  markRevoked,
  putConnection,
  type ConnectionRow,
} from '$lib/server/platforms/youtube/connection';
import { seed } from '../../../../../helpers/db';

const UID = 'sub-a';
const CHANNEL = 'UC-a';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/youtube.upload'];

const kms = vi.hoisted(() => ({ decrypt: vi.fn() }));
const oauth = vi.hoisted(() => ({
  options: [] as unknown[],
  setCredentials: vi.fn(),
  getAccessToken: vi.fn(),
}));

vi.mock('@google-cloud/kms', () => ({
  KeyManagementServiceClient: class {
    decrypt = kms.decrypt;
  },
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    constructor(options: unknown) {
      oauth.options.push(options);
    }
    setCredentials = oauth.setCredentials;
    getAccessToken = oauth.getAccessToken;
  },
}));

const connected = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  status: 'connected',
  channelId: CHANNEL,
  channelTitle: 'Flies Like Robots',
  scopes: SCOPES,
  tokenCiphertext: 'c2VhbGVk',
  ...overrides,
});

const invalidGrant = () =>
  Object.assign(new Error('reauth required'), { response: { data: { error: 'invalid_grant' } } });

beforeEach(async () => {
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'csecret');
  resetClients();
  vi.clearAllMocks();
  oauth.options.length = 0;
  kms.decrypt.mockResolvedValue([{ plaintext: Buffer.from('1//refresh') }]);
  await db().execute(sql`truncate users, invites cascade`);
  await seed({
    users: [
      { uid: UID, email: 'a@example.com' },
      { uid: 'sub-b', email: 'b@example.com' },
    ],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('putConnection / getConnection', () => {
  it('stores a new connection and reads it back', async () => {
    await putConnection(UID, connected());
    expect(await getConnection(UID)).toMatchObject({
      uid: UID,
      platform: 'youtube',
      ...connected(),
      updatedAt: expect.any(Date),
    });
  });

  it('replaces the whole row on reconnect', async () => {
    await putConnection(UID, connected());
    await putConnection(UID, {
      status: 'no_channel',
      channelId: null,
      channelTitle: null,
      scopes: ['openid'],
      tokenCiphertext: null,
    });
    expect(await getConnection(UID)).toMatchObject({
      status: 'no_channel',
      channelId: null,
      channelTitle: null,
      scopes: ['openid'],
      tokenCiphertext: null,
    });
  });

  it('returns null for a user with no connection', async () => {
    expect(await getConnection('sub-b')).toBeNull();
  });

  it('rejects a token on a connection that is not connected', async () => {
    await expect(
      putConnection(UID, connected({ status: 'missing_scopes', tokenCiphertext: 'x' })),
    ).rejects.toThrow();
    expect(await getConnection(UID)).toBeNull();
  });

  it('rejects an unknown user', async () => {
    await expect(putConnection('nobody', connected())).rejects.toThrow();
  });
});

describe('deleteConnection', () => {
  it("deletes only that user's connection", async () => {
    await putConnection(UID, connected());
    await putConnection('sub-b', connected({ channelId: 'UC-b' }));
    await deleteConnection(UID);
    expect(await getConnection(UID)).toBeNull();
    expect(await getConnection('sub-b')).not.toBeNull();
  });

  it('is a no-op without a connection', async () => {
    await expect(deleteConnection(UID)).resolves.toBeUndefined();
  });
});

describe('markRevoked', () => {
  it('sets revoked and clears the token in one write, keeping the channel', async () => {
    await putConnection(UID, connected());
    await markRevoked(UID);
    expect(await getConnection(UID)).toMatchObject({
      status: 'revoked',
      tokenCiphertext: null,
      channelId: CHANNEL,
    });
  });

  it('leaves a newer grant alone when named a stale token', async () => {
    await putConnection(UID, connected({ tokenCiphertext: 'bmV3' }));
    await markRevoked(UID, 'b2xk');
    expect(await getConnection(UID)).toMatchObject({
      status: 'connected',
      tokenCiphertext: 'bmV3',
    });
  });
});

describe('accessTokenFor', () => {
  it('decrypts the stored token and refreshes it', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: 'ya29.access' });
    expect(await accessTokenFor(UID, CHANNEL)).toBe('ya29.access');
    expect(kms.decrypt).toHaveBeenCalledWith({
      name: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      ciphertext: Buffer.from('c2VhbGVk', 'base64'),
    });
    expect(oauth.options).toEqual([{ clientId: 'cid', clientSecret: 'csecret' }]);
    expect(oauth.setCredentials).toHaveBeenCalledWith({ refresh_token: '1//refresh' });
  });

  it('returns null for a different channel without decrypting', async () => {
    await putConnection(UID, connected());
    expect(await accessTokenFor(UID, 'UC-other')).toBeNull();
    expect(kms.decrypt).not.toHaveBeenCalled();
  });

  it.each(['missing_scopes', 'no_channel', 'revoked'] as const)(
    'returns null when the connection is %s',
    async (status) => {
      await putConnection(UID, connected({ status, tokenCiphertext: null }));
      expect(await accessTokenFor(UID, CHANNEL)).toBeNull();
      expect(oauth.getAccessToken).not.toHaveBeenCalled();
    },
  );

  it('returns null with no connection or a connected row missing its token', async () => {
    expect(await accessTokenFor(UID, CHANNEL)).toBeNull();
    await putConnection(UID, connected({ tokenCiphertext: null }));
    expect(await accessTokenFor(UID, CHANNEL)).toBeNull();
    expect(kms.decrypt).not.toHaveBeenCalled();
  });

  it('returns null when Google returns no token', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: null });
    expect(await accessTokenFor(UID, CHANNEL)).toBeNull();
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it('marks the connection revoked on invalid_grant', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockRejectedValueOnce(invalidGrant());
    expect(await accessTokenFor(UID, CHANNEL)).toBeNull();
    expect(await getConnection(UID)).toMatchObject({ status: 'revoked', tokenCiphertext: null });
  });

  it('rethrows other refresh errors and keeps the grant', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(accessTokenFor(UID, CHANNEL)).rejects.toThrow('ECONNRESET');
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it('rethrows KMS failures without refreshing', async () => {
    await putConnection(UID, connected());
    kms.decrypt.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    await expect(accessTokenFor(UID, CHANNEL)).rejects.toThrow('PERMISSION_DENIED');
    expect(oauth.getAccessToken).not.toHaveBeenCalled();
  });
});

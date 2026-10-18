// @vitest-environment node
import { captureException, captureMessage } from '@sentry/sveltekit';
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
  revokeGrant,
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

type Connected = Extract<ConnectionRow, { status: 'connected' }>;

const connected = (overrides: Partial<Connected> = {}): Connected => ({
  status: 'connected',
  channelId: CHANNEL,
  channelTitle: 'Flies Like Robots',
  scopes: SCOPES,
  tokenCiphertext: 'c2VhbGVk',
  ...overrides,
});

/** A row the types forbid, to prove the table refuses it too. */
const unchecked = (overrides: Record<string, unknown>) =>
  ({ ...connected(), ...overrides }) as ConnectionRow;

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
  vi.unstubAllGlobals();
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
      putConnection(UID, unchecked({ status: 'missing_scopes', tokenCiphertext: 'x' })),
    ).rejects.toThrow();
    expect(await getConnection(UID)).toBeNull();
  });

  it.each([
    ['token', { tokenCiphertext: null }],
    ['channel', { channelId: null }],
  ])('rejects a connected row without its %s', async (_label, overrides) => {
    await expect(putConnection(UID, unchecked(overrides))).rejects.toThrow();
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
    await markRevoked(UID, 'c2VhbGVk');
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
    expect(await accessTokenFor(UID, CHANNEL)).toMatchObject({ token: 'ya29.access' });
    expect(kms.decrypt).toHaveBeenCalledWith({
      name: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      ciphertext: Buffer.from('c2VhbGVk', 'base64'),
    });
    expect(oauth.options).toEqual([{ clientId: 'cid', clientSecret: 'csecret' }]);
    expect(oauth.setCredentials).toHaveBeenCalledWith({ refresh_token: '1//refresh' });
  });

  it('revokes only its own grant once YouTube refuses the token, reporting no token', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: 'ya29.access' });
    const access = (await accessTokenFor(UID, CHANNEL))!;
    await access.refused('j1');
    expect(await getConnection(UID)).toMatchObject({ status: 'revoked', tokenCiphertext: null });
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith('YouTube refused the grant', {
      level: 'warning',
      tags: { 'job.id': 'j1' },
    });
    expect(JSON.stringify(vi.mocked(captureMessage).mock.calls)).not.toContain('ya29');
  });

  it('leaves a newer grant alone when an older token is refused', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: 'ya29.access' });
    const access = (await accessTokenFor(UID, CHANNEL))!;
    await putConnection(UID, connected({ tokenCiphertext: 'bmV3' }));
    await access.refused('j1');
    expect(await getConnection(UID)).toMatchObject({
      status: 'connected',
      tokenCiphertext: 'bmV3',
    });
  });

  it('reports a refused grant it could not mark revoked, and still returns', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: 'ya29.access' });
    const access = (await accessTokenFor(UID, CHANNEL))!;
    await db().execute(sql`
      create function refuse_write() returns trigger language plpgsql
        as $$ begin raise exception 'write refused'; end $$
    `);
    await db().execute(sql`
      create trigger refuse_write before update on connections
        for each row execute function refuse_write()
    `);
    try {
      await expect(access.refused('j1')).resolves.toBeUndefined();
    } finally {
      await db().execute(sql`drop trigger refuse_write on connections`);
      await db().execute(sql`drop function refuse_write`);
    }
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(
      expect.objectContaining({ cause: expect.objectContaining({ message: 'write refused' }) }),
      { tags: { 'job.id': 'j1', component: 'youtube-revoke-mark' } },
    );
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
    expect(JSON.stringify(vi.mocked(captureException).mock.calls)).not.toContain('ya29');
  });

  it('throws for a different channel without decrypting', async () => {
    await putConnection(UID, connected());
    await expect(accessTokenFor(UID, 'UC-other')).rejects.toThrow(
      "Connected channel doesn't match this job's channel.",
    );
    expect(kms.decrypt).not.toHaveBeenCalled();
    expect(await getConnection(UID)).toMatchObject({ status: 'connected', channelId: CHANNEL });
  });

  it.each(['missing_scopes', 'no_channel', 'revoked'] as const)(
    'returns null when the connection is %s',
    async (status) => {
      await putConnection(UID, { ...connected(), status, tokenCiphertext: null });
      expect(await accessTokenFor(UID, CHANNEL)).toBeNull();
      expect(oauth.getAccessToken).not.toHaveBeenCalled();
    },
  );

  it('returns null with no connection', async () => {
    expect(await accessTokenFor(UID, CHANNEL)).toBeNull();
    expect(kms.decrypt).not.toHaveBeenCalled();
  });

  it('throws when Google refreshes without an access token, keeping the grant', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: null });
    await expect(accessTokenFor(UID, CHANNEL)).rejects.toThrow('without an access token');
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it('marks the connection revoked on invalid_grant and reports it without the token', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockRejectedValueOnce(invalidGrant());
    expect(await accessTokenFor(UID, CHANNEL)).toBeNull();
    expect(await getConnection(UID)).toMatchObject({ status: 'revoked', tokenCiphertext: null });
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith('YouTube grant revoked', {
      level: 'info',
    });
    const reported = JSON.stringify(vi.mocked(captureMessage).mock.calls);
    expect(reported).not.toContain('c2VhbGVk');
    expect(reported).not.toContain('1//refresh');
  });

  it('reports the revoke even when recording it fails', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockRejectedValueOnce(invalidGrant());
    await db().execute(sql`
      create function refuse_write() returns trigger language plpgsql
        as $$ begin raise exception 'write refused'; end $$
    `);
    await db().execute(sql`
      create trigger refuse_write before update on connections
        for each row execute function refuse_write()
    `);
    try {
      await expect(accessTokenFor(UID, CHANNEL)).rejects.toMatchObject({
        cause: { message: 'write refused' },
      });
    } finally {
      await db().execute(sql`drop trigger refuse_write on connections`);
      await db().execute(sql`drop function refuse_write`);
    }
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith('YouTube grant revoked', {
      level: 'info',
    });
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it('wraps other refresh errors with their cause and keeps the grant', async () => {
    await putConnection(UID, connected());
    const cause = new Error('ECONNRESET');
    oauth.getAccessToken.mockRejectedValueOnce(cause);
    const error = await accessTokenFor(UID, CHANNEL).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ message: "Couldn't refresh the YouTube grant.", cause });
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
    expect(vi.mocked(captureMessage)).not.toHaveBeenCalled();
  });

  it('wraps KMS failures with their cause, without refreshing', async () => {
    await putConnection(UID, connected());
    const cause = new Error('PERMISSION_DENIED');
    kms.decrypt.mockRejectedValueOnce(cause);
    const error = await accessTokenFor(UID, CHANNEL).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ message: "Couldn't unlock the YouTube grant.", cause });
    expect(oauth.getAccessToken).not.toHaveBeenCalled();
  });
});

describe('revokeGrant', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('revokes the decrypted refresh token at Google, then deletes the row', async () => {
    await putConnection(UID, connected());
    await putConnection('sub-b', connected({ channelId: 'UC-b' }));
    expect(await revokeGrant(UID)).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(String(init!.body)).toBe('token=1%2F%2Frefresh');
    expect(await getConnection(UID)).toBeNull();
    expect(await getConnection('sub-b')).not.toBeNull();
  });

  it('reports a refused revoke without the token and deletes the row anyway', async () => {
    await putConnection(UID, connected());
    fetchMock.mockResolvedValue(new Response('{"error":"invalid_token"}', { status: 400 }));
    expect(await revokeGrant(UID)).toBe(false);
    expect(captureMessage).toHaveBeenCalledWith('YouTube revoke refused', {
      level: 'warning',
      tags: { status: 400 },
    });
    expect(JSON.stringify(vi.mocked(captureMessage).mock.calls)).not.toContain('refresh');
    expect(await getConnection(UID)).toBeNull();
  });

  it('reports a network failure and deletes the row anyway', async () => {
    await putConnection(UID, connected());
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await revokeGrant(UID)).toBe(false);
    expect(captureException).toHaveBeenCalledWith(expect.any(TypeError), {
      tags: { component: 'youtube-revoke' },
    });
    expect(await getConnection(UID)).toBeNull();
  });

  it('deletes the row without calling Google when KMS cannot unlock the token', async () => {
    await putConnection(UID, connected());
    kms.decrypt.mockRejectedValue(new Error('kms down'));
    expect(await revokeGrant(UID)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledOnce();
    expect(await getConnection(UID)).toBeNull();
  });

  it.each(['missing_scopes', 'no_channel', 'revoked'] as const)(
    'deletes a %s row without calling Google, since it holds no token',
    async (status) => {
      await putConnection(UID, {
        status,
        channelId: null,
        channelTitle: null,
        scopes: [],
        tokenCiphertext: null,
      });
      expect(await revokeGrant(UID)).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await getConnection(UID)).toBeNull();
    },
  );

  it('is a no-op without a connection', async () => {
    expect(await revokeGrant(UID)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

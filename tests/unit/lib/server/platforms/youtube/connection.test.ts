// @vitest-environment node
import { captureException, captureMessage } from '@sentry/sveltekit';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { DeadlineExceeded } from '#lib/server/core/deadline.js';
import {
  accessTokenFor,
  analyticsShared,
  getConnection,
  markRevoked,
  ownChannelUploads,
  putConnection,
  revokeGrant,
  type ConnectionRow,
} from '#lib/server/platforms/youtube/connection.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { query } from '#lib/server/core/db.js';
import { artistGuides, artistOutcomes } from '#lib/server/core/schema.js';
import {
  ANALYTICS_SCOPE,
  DeadlineSpent,
  identityFailure,
} from '#lib/server/platforms/youtube/youtube.js';
import { seed } from '../../../../../helpers/db';
import { approvedGuide, pendingProposal } from '../../../../../helpers/pipeline';

const UID = 'sub-a';
/** A step deadline with time to spare. */
const later = () => Date.now() + 60_000;
const CHANNEL = 'UC-a';
const ACCESS = 'access-a';
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
type Failed = Exclude<ConnectionRow, Connected>;

const failed = (overrides: Partial<Failed> = {}): Failed => ({
  status: 'no_channel',
  channelId: null,
  channelTitle: null,
  scopes: ['openid'],
  tokenCiphertext: null,
  ...overrides,
});

const unchecked = (overrides: Record<string, unknown>) =>
  ({ ...connected(), ...overrides }) as ConnectionRow;

const DECRYPTION_FAILED = "Decryption failed: verify that 'name' refers to the correct CryptoKey.";
/** The shape @google-cloud/kms rejects with for an INVALID_ARGUMENT request. */
const kmsRefusal = (details: string) =>
  Object.assign(new Error(`3 INVALID_ARGUMENT: ${details}`), { code: 3, details });

/** A grant by its token; the generation only matters to the proposal tests. */
const grant = (tokenCiphertext: string, updatedAt = new Date(0)) => ({
  tokenCiphertext,
  updatedAt,
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
  await db().execute(sql`truncate users cascade`);
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
      ...connected(),
      updatedAt: expect.any(Date),
    });
  });

  it('replaces the whole row on reconnect', async () => {
    await putConnection(UID, failed());
    await putConnection(UID, connected());
    expect(await getConnection(UID)).toMatchObject(connected());
  });

  it('replaces a failed row with another failure', async () => {
    await putConnection(UID, failed());
    await putConnection(UID, failed({ status: 'missing_scopes', scopes: ['openid', 'email'] }));
    expect(await getConnection(UID)).toMatchObject({
      status: 'missing_scopes',
      scopes: ['openid', 'email'],
    });
  });

  it('never replaces a connected row with a failure', async () => {
    await putConnection(UID, connected());
    await putConnection(UID, failed());
    expect(await getConnection(UID)).toMatchObject(connected());
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

describe('markRevoked', () => {
  it('sets revoked and clears the token in one write, keeping the channel', async () => {
    await putConnection(UID, connected());
    await markRevoked(UID, grant('c2VhbGVk'));
    expect(await getConnection(UID)).toMatchObject({
      status: 'revoked',
      tokenCiphertext: null,
      channelId: CHANNEL,
    });
  });

  it('leaves a newer grant alone when named a stale token', async () => {
    await putConnection(UID, connected({ tokenCiphertext: 'bmV3' }));
    await markRevoked(UID, grant('b2xk'));
    expect(await getConnection(UID)).toMatchObject({
      status: 'connected',
      tokenCiphertext: 'bmV3',
    });
  });
});

describe('analyticsShared', () => {
  it('is true only for a connected grant with the analytics scope', () => {
    expect(analyticsShared({ status: 'connected', scopes: [...SCOPES, ANALYTICS_SCOPE] })).toBe(
      true,
    );
    expect(analyticsShared({ status: 'connected', scopes: SCOPES })).toBe(false);
    expect(analyticsShared({ status: 'revoked', scopes: [ANALYTICS_SCOPE] })).toBe(false);
    expect(analyticsShared(null)).toBe(false);
  });
});

describe('accessTokenFor', () => {
  it("returns the grant's generation with the token", async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: 'access-token' });
    const access = await accessTokenFor(UID, CHANNEL, later());
    expect(access!.grantAt).toEqual((await getConnection(UID))!.updatedAt);
  });

  it('decrypts the stored token and refreshes it', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: ACCESS });
    expect(await accessTokenFor(UID, CHANNEL, later())).toMatchObject({ token: ACCESS });
    expect(kms.decrypt).toHaveBeenCalledWith(
      {
        name: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
        ciphertext: Buffer.from('c2VhbGVk', 'base64'),
      },
      { timeout: expect.any(Number) },
    );
    const [, { timeout }] = kms.decrypt.mock.calls[0] as [unknown, { timeout: number }];
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(60_000);
    expect(oauth.options).toEqual([
      {
        clientId: 'cid',
        clientSecret: 'csecret',
        transporterOptions: { signal: expect.any(AbortSignal) },
      },
    ]);
    expect(oauth.setCredentials).toHaveBeenCalledWith({ refresh_token: '1//refresh' });
  });

  it('revokes only its own grant once YouTube refuses the token, reporting no token', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: ACCESS });
    const access = (await accessTokenFor(UID, CHANNEL, later()))!;
    await access.refused({ 'job.id': 'j1' });
    expect(await getConnection(UID)).toMatchObject({ status: 'revoked', tokenCiphertext: null });
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith('YouTube refused the grant', {
      level: 'warning',
      tags: { 'job.id': 'j1' },
    });
    expect(JSON.stringify(vi.mocked(captureMessage).mock.calls)).not.toContain(ACCESS);
  });

  it('reports a refused grant with no job untagged', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: 'access-token' });
    await (await accessTokenFor(UID, CHANNEL, later()))!.refused();
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith('YouTube refused the grant', {
      level: 'warning',
      tags: {},
    });
  });

  it('gives up at the deadline when KMS stalls, keeping the grant and making no refresh', async () => {
    await putConnection(UID, connected());
    kms.decrypt.mockReturnValueOnce(new Promise(() => {}));
    await expect(accessTokenFor(UID, CHANNEL, Date.now() + 30)).rejects.toBeInstanceOf(
      DeadlineSpent,
    );
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
    expect(oauth.getAccessToken).not.toHaveBeenCalled();
  });

  it('reads a KMS refusal that lands after the deadline as out of time, not a lost grant', async () => {
    await putConnection(UID, connected());
    const deadline = Date.now() + 20;
    kms.decrypt.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      throw kmsRefusal(DECRYPTION_FAILED);
    });
    await expect(accessTokenFor(UID, CHANNEL, deadline)).rejects.toBeInstanceOf(DeadlineSpent);
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it('reads a KMS timeout that fires a moment before the deadline as out of time', async () => {
    await putConnection(UID, connected());
    kms.decrypt.mockRejectedValueOnce(new DeadlineExceeded('KMS decrypt', 26));
    await expect(accessTokenFor(UID, CHANNEL, later())).rejects.toBeInstanceOf(DeadlineSpent);
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it('reads gax giving up on its own timeout as out of time, keeping the grant', async () => {
    await putConnection(UID, connected());
    kms.decrypt.mockRejectedValueOnce(Object.assign(new Error('4 DEADLINE_EXCEEDED'), { code: 4 }));
    await expect(accessTokenFor(UID, CHANNEL, later())).rejects.toBeInstanceOf(DeadlineSpent);
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it('makes no read, decrypt or refresh once the deadline has passed', async () => {
    await putConnection(UID, connected());
    await expect(accessTokenFor(UID, CHANNEL, Date.now() - 1)).rejects.toBeInstanceOf(
      DeadlineSpent,
    );
    expect(kms.decrypt).not.toHaveBeenCalled();
    expect(oauth.getAccessToken).not.toHaveBeenCalled();
  });

  it('gives up on a token endpoint that never answers at the deadline, not later', async () => {
    await putConnection(UID, connected());
    // Gaxios aborts on the transporter signal, as the real refresh does.
    oauth.getAccessToken.mockImplementationOnce(() => {
      const { signal } = (oauth.options.at(-1) as { transporterOptions: { signal: AbortSignal } })
        .transporterOptions;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    });
    const started = Date.now();
    const error = await accessTokenFor(UID, CHANNEL, started + 50).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(identityFailure(error)).toBe('busy');
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it('leaves a newer grant alone when an older token is refused', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: ACCESS });
    const access = (await accessTokenFor(UID, CHANNEL, later()))!;
    await putConnection(UID, connected({ tokenCiphertext: 'bmV3' }));
    await access.refused({ 'job.id': 'j1' });
    expect(await getConnection(UID)).toMatchObject({
      status: 'connected',
      tokenCiphertext: 'bmV3',
    });
  });

  it('reports a refused grant it could not mark revoked, and still returns', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: ACCESS });
    const access = (await accessTokenFor(UID, CHANNEL, later()))!;
    await db().execute(sql`
      create function refuse_write() returns trigger language plpgsql
        as $$ begin raise exception 'write refused'; end $$
    `);
    await db().execute(sql`
      create trigger refuse_write before update on connections
        for each row execute function refuse_write()
    `);
    try {
      await expect(access.refused({ 'job.id': 'j1' })).resolves.toBeUndefined();
    } finally {
      await db().execute(sql`drop trigger refuse_write on connections`);
      await db().execute(sql`drop function refuse_write`);
    }
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(
      expect.objectContaining({ cause: expect.objectContaining({ message: 'write refused' }) }),
      { tags: { 'job.id': 'j1', component: 'youtube-revoke-mark' } },
    );
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
    expect(JSON.stringify(vi.mocked(captureException).mock.calls)).not.toContain(ACCESS);
  });

  it('throws for a different channel without decrypting', async () => {
    await putConnection(UID, connected());
    await expect(accessTokenFor(UID, 'UC-other', later())).rejects.toThrow(
      "Connected channel doesn't match this job's channel.",
    );
    expect(kms.decrypt).not.toHaveBeenCalled();
    expect(await getConnection(UID)).toMatchObject({ status: 'connected', channelId: CHANNEL });
  });

  it.each(['missing_scopes', 'no_channel', 'revoked'] as const)(
    'returns null when the connection is %s',
    async (status) => {
      await putConnection(UID, { ...connected(), status, tokenCiphertext: null });
      expect(await accessTokenFor(UID, CHANNEL, later())).toBeNull();
      expect(oauth.getAccessToken).not.toHaveBeenCalled();
    },
  );

  it('returns null with no connection', async () => {
    expect(await accessTokenFor(UID, CHANNEL, later())).toBeNull();
    expect(kms.decrypt).not.toHaveBeenCalled();
  });

  it('throws when Google refreshes without an access token, keeping the grant', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockResolvedValueOnce({ token: null });
    await expect(accessTokenFor(UID, CHANNEL, later())).rejects.toThrow('without an access token');
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it('marks the connection revoked on invalid_grant and reports it without the token', async () => {
    await putConnection(UID, connected());
    oauth.getAccessToken.mockRejectedValueOnce(invalidGrant());
    expect(await accessTokenFor(UID, CHANNEL, later())).toBeNull();
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
      await expect(accessTokenFor(UID, CHANNEL, later())).rejects.toMatchObject({
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
    const error = await accessTokenFor(UID, CHANNEL, later()).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ message: "Couldn't refresh the YouTube grant.", cause });
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
    expect(vi.mocked(captureMessage)).not.toHaveBeenCalled();
  });

  it('gives up a grant KMS cannot decrypt under its key and returns null, without refreshing', async () => {
    await putConnection(UID, connected());
    kms.decrypt.mockRejectedValueOnce(kmsRefusal(DECRYPTION_FAILED));
    expect(await accessTokenFor(UID, CHANNEL, later())).toBeNull();
    expect(await getConnection(UID)).toMatchObject({ status: 'revoked', tokenCiphertext: null });
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith('YouTube grant does not decrypt', {
      level: 'warning',
    });
    expect(oauth.getAccessToken).not.toHaveBeenCalled();
  });

  it('keeps a grant a reconnect replaced while KMS refused the old one', async () => {
    await putConnection(UID, connected());
    kms.decrypt.mockImplementationOnce(async () => {
      await putConnection(UID, connected({ tokenCiphertext: 'bmV3ZXI=' }));
      throw kmsRefusal(DECRYPTION_FAILED);
    });
    expect(await accessTokenFor(UID, CHANNEL, later())).toBeNull();
    expect(await getConnection(UID)).toMatchObject({
      status: 'connected',
      tokenCiphertext: 'bmV3ZXI=',
    });
  });

  it('throws on a malformed key name, keeping the grant', async () => {
    await putConnection(UID, connected());
    const cause = kmsRefusal('Resource name [k] does not match any known resource name pattern.');
    kms.decrypt.mockRejectedValueOnce(cause);
    const error = await accessTokenFor(UID, CHANNEL, later()).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ message: "Couldn't unlock the YouTube grant.", cause });
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it('wraps KMS failures with their cause, without refreshing', async () => {
    await putConnection(UID, connected());
    const cause = new Error('PERMISSION_DENIED');
    kms.decrypt.mockRejectedValueOnce(cause);
    const error = await accessTokenFor(UID, CHANNEL, later()).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ message: "Couldn't unlock the YouTube grant.", cause });
    expect(oauth.getAccessToken).not.toHaveBeenCalled();
  });
});

describe('ownChannelUploads', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const uploads = () =>
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/channels')) {
        return answer(200, {
          items: [{ id: CHANNEL, contentDetails: { relatedPlaylists: { uploads: 'UUa' } } }],
        });
      }
      if (url.includes('/playlistItems')) {
        return answer(200, { items: [{ contentDetails: { videoId: 'v1' } }] });
      }
      return answer(200, { items: [{ id: 'v1', snippet: { title: 'Song' } }] });
    });
  const refusal = (status: number, reason: string) =>
    answer(status, { error: { errors: [{ reason }] } });

  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    oauth.getAccessToken.mockResolvedValue({ token: 'access-token' });
    await putConnection(UID, connected());
  });

  it("reads the user's own connected channel through their own token", async () => {
    uploads();
    const videos = await ownChannelUploads(UID, 3, later(), { 'job.id': 'j1' });
    expect(videos).toMatchObject([{ videoId: 'v1', title: 'Song' }]);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer access-token');
    }
  });

  it('reads a channel with no videos as no uploads and keeps the grant', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('/channels')
        ? answer(200, {
            items: [{ id: CHANNEL, contentDetails: { relatedPlaylists: { uploads: 'UUa' } } }],
          })
        : refusal(404, 'playlistNotFound'),
    );
    expect(await ownChannelUploads(UID, 3, later())).toEqual([]);
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it.each(['missing_scopes', 'no_channel', 'revoked'] as const)(
    'waits on a reconnect when the connection is %s, with no YouTube call',
    async (status) => {
      await db().execute(sql`truncate connections`);
      await putConnection(UID, { ...connected(), status, tokenCiphertext: null });
      expect(await ownChannelUploads(UID, 3, later())).toEqual({ wait: 'reconnect YouTube' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('waits on a reconnect with no connection at all', async () => {
    expect(await ownChannelUploads('sub-b', 3, later())).toEqual({ wait: 'reconnect YouTube' });
  });

  it('gives up a grant KMS cannot decrypt and waits on a reconnect, with no YouTube call', async () => {
    kms.decrypt.mockRejectedValueOnce(kmsRefusal(DECRYPTION_FAILED));
    expect(await ownChannelUploads(UID, 3, later())).toEqual({ wait: 'reconnect YouTube' });
    expect(await getConnection(UID)).toMatchObject({ status: 'revoked' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waits on YouTube when KMS stalls past the deadline, keeping the grant', async () => {
    kms.decrypt.mockReturnValueOnce(new Promise(() => {}));
    expect(await ownChannelUploads(UID, 3, Date.now() + 30)).toEqual({
      wait: 'waiting on YouTube',
    });
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when KMS itself fails, keeping the grant', async () => {
    kms.decrypt.mockRejectedValueOnce(new Error('UNAVAILABLE'));
    await expect(ownChannelUploads(UID, 3, later())).rejects.toThrow(
      "Couldn't unlock the YouTube grant.",
    );
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it('marks a revoked grant on refresh and waits on a reconnect', async () => {
    oauth.getAccessToken.mockRejectedValueOnce(invalidGrant());
    expect(await ownChannelUploads(UID, 3, later())).toEqual({ wait: 'reconnect YouTube' });
    expect(await getConnection(UID)).toMatchObject({ status: 'revoked' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a 401', answer(401, {})],
    ['a 403 playlistItemsNotAccessible', refusal(403, 'playlistItemsNotAccessible')],
    ['a 403 forbidden', refusal(403, 'forbidden')],
  ])('gives up the grant on %s and waits on a reconnect', async (_label, response) => {
    fetchMock.mockResolvedValueOnce(response);
    expect(await ownChannelUploads(UID, 3, later(), { 'job.id': 'j1' })).toEqual({
      wait: 'reconnect YouTube',
    });
    expect(await getConnection(UID)).toMatchObject({ status: 'revoked' });
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith('YouTube refused the grant', {
      level: 'warning',
      tags: { 'job.id': 'j1' },
    });
  });

  it.each([
    ['a 403 quotaExceeded', refusal(403, 'quotaExceeded')],
    ['a 429', answer(429, {})],
    ['a 503', answer(503, {})],
  ])('waits on YouTube on %s, leaving the grant alone', async (_label, response) => {
    fetchMock.mockResolvedValueOnce(response);
    expect(await ownChannelUploads(UID, 3, later())).toEqual({ wait: 'waiting on YouTube' });
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
  });

  it('waits on YouTube when the deadline is already spent, with no call', async () => {
    expect(await ownChannelUploads(UID, 3, Date.now() - 1)).toEqual({
      wait: 'waiting on YouTube',
    });
    expect(oauth.getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when Google rejects the app itself', async () => {
    oauth.getAccessToken.mockRejectedValueOnce(
      Object.assign(new Error('bad client'), {
        response: { status: 401, data: { error: 'invalid_client' } },
      }),
    );
    await expect(ownChannelUploads(UID, 3, later())).rejects.toThrow(
      "Couldn't refresh the YouTube grant.",
    );
    expect(await getConnection(UID)).toMatchObject({ status: 'connected' });
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

  it('warns, rather than errors, when the stored grant no longer decrypts', async () => {
    await putConnection(UID, connected());
    kms.decrypt.mockRejectedValue(kmsRefusal(DECRYPTION_FAILED));
    expect(await revokeGrant(UID)).toBe(false);
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledWith('YouTube grant does not decrypt', {
      level: 'warning',
      tags: { component: 'youtube-revoke' },
    });
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

  it('keeps a reconnect that lands while Google answers the revoke', async () => {
    await putConnection(UID, connected());
    fetchMock.mockImplementation(async () => {
      await putConnection(UID, connected({ tokenCiphertext: 'bmV3' }));
      return new Response('', { status: 200 });
    });
    expect(await revokeGrant(UID)).toBe(true);
    expect(await getConnection(UID)).toMatchObject({
      status: 'connected',
      tokenCiphertext: 'bmV3',
    });
  });

  it('still deletes a row a step marked revoked while Google answered', async () => {
    await putConnection(UID, connected());
    fetchMock.mockImplementation(async () => {
      await markRevoked(UID, grant('c2VhbGVk'));
      return new Response('', { status: 200 });
    });
    expect(await revokeGrant(UID)).toBe(true);
    expect(await getConnection(UID)).toBeNull();
  });
});

describe('guide proposals across grants', () => {
  const ARTIST = 'artist-a';
  const fetchMock = vi.fn<typeof fetch>();
  const rules = (rule: string) => ({ rules: [rule] });
  const kinds = async () =>
    (
      await db()
        .select({ body: artistGuides.body, status: artistGuides.status })
        .from(artistGuides)
        .orderBy(artistGuides.id)
    ).map(({ body, status }) => `${status}:${(body as { rules: string[] }).rules[0]}`);
  const generation = async () => (await getConnection(UID))!.updatedAt;

  beforeEach(async () => {
    await db().execute(sql`truncate artists cascade`);
    await seed({
      artists: [{ id: ARTIST, name: 'A Band' }],
      users: [{ uid: UID, email: 'a@example.com', artistId: ARTIST }],
    });
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await putConnection(UID, connected());
  });

  it('drops the revoked grant proposals and the unbound ones, keeping approved guides', async () => {
    const old = await generation();
    await seed({
      artistGuides: [
        approvedGuide(ARTIST, 'voice', rules('kept')),
        pendingProposal(ARTIST, 'brand', rules('old grant'), { grantAt: old }),
        pendingProposal(ARTIST, 'voice', rules('edits only')),
      ],
    });
    await markRevoked(UID, grant('c2VhbGVk', old));
    expect(await kinds()).toEqual(['approved:kept']);
  });

  it('keeps unbound proposals when a late refusal finds a newer grant', async () => {
    const old = await generation();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await putConnection(UID, connected({ tokenCiphertext: 'bmV3' }));
    await seed({
      artistGuides: [
        pendingProposal(ARTIST, 'voice', rules('edits only')),
        pendingProposal(ARTIST, 'brand', rules('new grant'), { grantAt: await generation() }),
      ],
    });
    await markRevoked(UID, grant('c2VhbGVk', old));
    expect(await kinds()).toEqual(['proposed:edits only', 'proposed:new grant']);
  });

  it('keeps a proposal saved on a new grant when the old one is refused late', async () => {
    oauth.getAccessToken.mockResolvedValueOnce({ token: 'access-token' });
    const access = (await accessTokenFor(UID, CHANNEL, later()))!;
    const old = await generation();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await putConnection(UID, connected({ tokenCiphertext: 'bmV3' }));
    const fresh = await generation();
    await seed({
      artistGuides: [
        pendingProposal(ARTIST, 'voice', rules('old grant'), { grantAt: old }),
        pendingProposal(ARTIST, 'brand', rules('new grant'), { grantAt: fresh }),
      ],
    });
    await access.refused();
    expect(await getConnection(UID)).toMatchObject({
      status: 'connected',
      tokenCiphertext: 'bmV3',
    });
    expect(await kinds()).toEqual(['proposed:new grant']);
  });

  it('drops the disconnected grant proposals, and spares a reconnect that lands while Google answers', async () => {
    const old = await generation();
    await seed({
      artistGuides: [pendingProposal(ARTIST, 'voice', rules('old grant'), { grantAt: old })],
    });
    fetchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await putConnection(UID, connected({ tokenCiphertext: 'bmV3' }));
      await seed({
        artistGuides: [
          pendingProposal(ARTIST, 'brand', rules('new grant'), { grantAt: await generation() }),
        ],
      });
      return new Response('', { status: 200 });
    });
    expect(await revokeGrant(UID)).toBe(true);
    expect(await getConnection(UID)).toMatchObject({ tokenCiphertext: 'bmV3' });
    expect(await kinds()).toEqual(['proposed:new grant']);
  });

  it('drops unbound proposals with the grant on disconnect', async () => {
    await seed({
      artistGuides: [
        pendingProposal(ARTIST, 'voice', rules('edits only')),
        pendingProposal(ARTIST, 'brand', rules('old grant'), { grantAt: await generation() }),
      ],
    });
    expect(await revokeGrant(UID)).toBe(true);
    expect(await getConnection(UID)).toBeNull();
    expect(await kinds()).toEqual([]);
  });

  it('drops proposals of a grant a reconnect replaced, with the current one, on disconnect', async () => {
    const first = await generation();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await putConnection(UID, connected({ tokenCiphertext: 'bmV3' }));
    await seed({
      artistGuides: [
        pendingProposal(ARTIST, 'voice', rules('first grant'), { grantAt: first }),
        pendingProposal(ARTIST, 'brand', rules('second grant'), { grantAt: await generation() }),
      ],
    });
    expect(await revokeGrant(UID)).toBe(true);
    expect(await kinds()).toEqual([]);
  });

  it('drops proposals of a replaced grant when the current one is refused', async () => {
    const first = await generation();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await putConnection(UID, connected({ tokenCiphertext: 'bmV3' }));
    await seed({
      artistGuides: [pendingProposal(ARTIST, 'voice', rules('first grant'), { grantAt: first })],
    });
    await markRevoked(UID, grant('bmV3', await generation()));
    expect(await kinds()).toEqual([]);
  });

  it('keeps unbound proposals when a reconnect lands while Google answers the disconnect', async () => {
    await seed({ artistGuides: [pendingProposal(ARTIST, 'voice', rules('edits only'))] });
    fetchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await putConnection(UID, connected({ tokenCiphertext: 'bmV3' }));
      return new Response('', { status: 200 });
    });
    await revokeGrant(UID);
    expect(await kinds()).toEqual(['proposed:edits only']);
  });

  it("never drops another artist's proposals", async () => {
    const old = await generation();
    await seed({
      artists: [{ id: 'artist-b', name: 'B Band' }],
      artistGuides: [pendingProposal('artist-b', 'voice', rules('theirs'), { grantAt: old })],
    });
    await revokeGrant(UID);
    expect(await kinds()).toEqual(['proposed:theirs']);
  });
});

describe('artist outcomes across sharing', () => {
  const SHARED = [...SCOPES, ANALYTICS_SCOPE];
  const outcome = (artistId: string, videoId: string) => ({
    artistId,
    videoId,
    retrievedAt: new Date(),
    publishedAt: new Date(Date.now() - 40 * 24 * 60 * 60_000),
    requestedStart: '2026-09-01',
    requestedEnd: '2026-09-28',
    coverage: 'complete' as const,
    metrics: { views: 10, subscribersGained: 1, subscribersLost: 0 },
    live: { title: 'Song', description: '', tags: [] },
  });
  const stored = async () =>
    (await db().select({ artistId: artistOutcomes.artistId }).from(artistOutcomes))
      .map((row) => row.artistId)
      .toSorted();
  /** What review reads: the caller's outcomes under RLS. */
  const visible = () => withIdentity(UID, () => query((tx) => tx.select().from(artistOutcomes)));

  beforeEach(async () => {
    await db().execute(sql`truncate artists cascade`);
    await seed({
      artists: [
        { id: 'art-1', name: 'Artist One' },
        { id: 'art-2', name: 'Artist Two' },
      ],
      users: [
        { uid: UID, email: 'a@example.com', artistId: 'art-1' },
        { uid: 'sub-b', email: 'b@example.com', artistId: 'art-2' },
      ],
    });
    await putConnection(UID, connected({ scopes: SHARED }));
    await putConnection('sub-b', connected({ channelId: 'UC-b', scopes: SHARED }));
    await seed({ artistOutcomes: [outcome('art-1', 'v1'), outcome('art-2', 'v2')] });
  });

  it('shows the artist their own results while the grant is shared', async () => {
    expect((await visible()).map((row) => row.videoId)).toEqual(['v1']);
  });

  it('deletes them when the grant is marked revoked, sparing every other artist', async () => {
    await markRevoked(UID, grant('c2VhbGVk'));
    expect(await stored()).toEqual(['art-2']);
    expect(await visible()).toEqual([]);
  });

  it('keeps them when a stale token is refused after a reconnect', async () => {
    await putConnection(UID, connected({ scopes: SHARED, tokenCiphertext: 'bmV3' }));
    await markRevoked(UID, grant('b2xk'));
    expect(await stored()).toEqual(['art-1', 'art-2']);
  });

  it('deletes them when Disconnect removes the connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 200 })),
    );
    await revokeGrant(UID);
    expect(await stored()).toEqual(['art-2']);
    expect(await visible()).toEqual([]);
  });

  it('deletes them when a reconnect drops the Analytics scope', async () => {
    await putConnection(UID, connected({ scopes: SCOPES }));
    expect(await stored()).toEqual(['art-2']);
  });

  it('keeps them when a reconnect keeps the scope', async () => {
    await putConnection(UID, connected({ scopes: SHARED, tokenCiphertext: 'bmV3' }));
    expect(await stored()).toEqual(['art-1', 'art-2']);
  });

  it('hides them at once, before any delete, while sharing is off', async () => {
    await db().execute(sql`update connections set scopes = '{}' where uid = ${UID}`);
    await seed({ artistOutcomes: [outcome('art-1', 'v3')] });
    expect(await visible()).toEqual([]);
  });

  it('has nothing to delete for a connection that never shared', async () => {
    await putConnection('sub-b', connected({ channelId: 'UC-b', scopes: SCOPES }));
    await seed({ artistOutcomes: [outcome('art-2', 'v4')] });
    await putConnection('sub-b', connected({ channelId: 'UC-b', scopes: SCOPES }));
    expect(await stored()).toEqual(['art-1', 'art-2']);
  });

  it('keeps platform code free of the research and artist-memory domains', () => {
    const imports = (file: string) =>
      readFileSync(`src/lib/server/platforms/youtube/${file}`, 'utf8').match(
        /#lib\/server\/(?:artist|research)\/[\w-]+\.js/g,
      ) ?? [];
    expect(imports('analytics.ts')).toEqual([]);
    expect(imports('youtube.ts')).toEqual([]);
    expect(imports('index.ts')).toEqual([]);
    // Dropping guide proposals with a grant is 005's only dependency.
    expect(imports('connection.ts')).toEqual(['#lib/server/artist/guides.js']);
  });
});

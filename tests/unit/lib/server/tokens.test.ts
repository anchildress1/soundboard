// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/clients';
import { accessToken, getRefreshToken, storeRefreshToken } from '$lib/server/tokens';

const sm = vi.hoisted(() => ({
  accessSecretVersion: vi.fn(),
  addSecretVersion: vi.fn(),
  createSecret: vi.fn(),
}));
const oauth = vi.hoisted(() => ({
  options: [] as unknown[],
  setCredentials: vi.fn(),
  getAccessToken: vi.fn(),
}));

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    accessSecretVersion = sm.accessSecretVersion;
    addSecretVersion = sm.addSecretVersion;
    createSecret = sm.createSecret;
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

const notFound = () => Object.assign(new Error('NOT_FOUND'), { code: 5 });
const denied = () => Object.assign(new Error('PERMISSION_DENIED'), { code: 7 });
const version = (token: string) => [{ payload: { data: new TextEncoder().encode(token) } }];

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'proj');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'csecret');
  resetClients();
  vi.clearAllMocks();
  oauth.options.length = 0;
});

describe('getRefreshToken', () => {
  it("reads the latest version of the channel's secret", async () => {
    sm.accessSecretVersion.mockResolvedValueOnce(version('refresh-1'));
    expect(await getRefreshToken('nathan')).toBe('refresh-1');
    expect(sm.accessSecretVersion).toHaveBeenCalledWith({
      name: 'projects/proj/secrets/yt-refresh-nathan/versions/latest',
    });
  });

  it('uses a separate secret for the sandbox channel', async () => {
    sm.accessSecretVersion.mockResolvedValueOnce(version('sandbox-token'));
    expect(await getRefreshToken('sandbox')).toBe('sandbox-token');
    expect(sm.accessSecretVersion.mock.calls[0]![0]).toEqual({
      name: 'projects/proj/secrets/yt-refresh-sandbox/versions/latest',
    });
  });

  it('returns null when the secret does not exist', async () => {
    sm.accessSecretVersion.mockRejectedValueOnce(notFound());
    expect(await getRefreshToken('nathan')).toBeNull();
  });

  it('rethrows other errors', async () => {
    sm.accessSecretVersion.mockRejectedValueOnce(denied());
    await expect(getRefreshToken('nathan')).rejects.toThrow('PERMISSION_DENIED');
  });

  it('rethrows errors without a code', async () => {
    sm.accessSecretVersion.mockRejectedValueOnce(new Error('network'));
    await expect(getRefreshToken('nathan')).rejects.toThrow('network');
  });

  it('returns null for an empty payload', async () => {
    sm.accessSecretVersion.mockResolvedValueOnce([{ payload: {} }]);
    expect(await getRefreshToken('nathan')).toBeNull();
    sm.accessSecretVersion.mockResolvedValueOnce([{}]);
    expect(await getRefreshToken('nathan')).toBeNull();
  });

  it('throws without a project id', async () => {
    vi.stubEnv('GCP_PROJECT_ID', '');
    await expect(getRefreshToken('nathan')).rejects.toThrow('GCP_PROJECT_ID');
  });
});

describe('storeRefreshToken', () => {
  it('adds a version to an existing secret', async () => {
    sm.addSecretVersion.mockResolvedValueOnce([{}]);
    await storeRefreshToken('nathan', 'tok');
    expect(sm.createSecret).not.toHaveBeenCalled();
    const call = sm.addSecretVersion.mock.calls[0]![0] as {
      parent: string;
      payload: { data: Buffer };
    };
    expect(call.parent).toBe('projects/proj/secrets/yt-refresh-nathan');
    expect(Buffer.from(call.payload.data).toString('utf8')).toBe('tok');
  });

  it('creates the secret on first connect, then adds the version', async () => {
    sm.addSecretVersion.mockRejectedValueOnce(notFound()).mockResolvedValueOnce([{}]);
    sm.createSecret.mockResolvedValueOnce([{}]);
    await storeRefreshToken('sandbox', 'tok2');
    expect(sm.createSecret).toHaveBeenCalledWith({
      parent: 'projects/proj',
      secretId: 'yt-refresh-sandbox',
      secret: { replication: { automatic: {} } },
    });
    expect(sm.addSecretVersion).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-NOT_FOUND errors without creating', async () => {
    sm.addSecretVersion.mockRejectedValueOnce(denied());
    await expect(storeRefreshToken('nathan', 'tok')).rejects.toThrow('PERMISSION_DENIED');
    expect(sm.createSecret).not.toHaveBeenCalled();
  });

  it('propagates a failure to create the secret', async () => {
    sm.addSecretVersion.mockRejectedValueOnce(notFound());
    sm.createSecret.mockRejectedValueOnce(denied());
    await expect(storeRefreshToken('nathan', 'tok')).rejects.toThrow('PERMISSION_DENIED');
    expect(sm.addSecretVersion).toHaveBeenCalledTimes(1);
  });
});

describe('accessToken', () => {
  it('mints an access token from the stored refresh token', async () => {
    sm.accessSecretVersion.mockResolvedValueOnce(version('refresh-1'));
    oauth.getAccessToken.mockResolvedValueOnce({ token: 'access-1' });
    expect(await accessToken('nathan')).toBe('access-1');
    expect(oauth.options).toEqual([{ clientId: 'cid', clientSecret: 'csecret' }]);
    expect(oauth.setCredentials).toHaveBeenCalledWith({ refresh_token: 'refresh-1' });
  });

  it('returns null without a refresh token and never builds a client', async () => {
    sm.accessSecretVersion.mockRejectedValueOnce(notFound());
    expect(await accessToken('nathan')).toBeNull();
    expect(oauth.options).toHaveLength(0);
    expect(oauth.getAccessToken).not.toHaveBeenCalled();
  });

  it('returns null when Google returns no token', async () => {
    sm.accessSecretVersion.mockResolvedValueOnce(version('refresh-1'));
    oauth.getAccessToken.mockResolvedValueOnce({ token: null });
    expect(await accessToken('nathan')).toBeNull();
  });

  it('propagates a refresh failure', async () => {
    sm.accessSecretVersion.mockResolvedValueOnce(version('refresh-1'));
    oauth.getAccessToken.mockRejectedValueOnce(new Error('invalid_grant'));
    await expect(accessToken('nathan')).rejects.toThrow('invalid_grant');
  });

  it('requires the OAuth client credentials', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', '');
    sm.accessSecretVersion.mockResolvedValueOnce(version('refresh-1'));
    await expect(accessToken('nathan')).rejects.toThrow('GOOGLE_OAUTH_CLIENT_SECRET');
  });
});

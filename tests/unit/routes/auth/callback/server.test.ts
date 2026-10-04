// @vitest-environment node
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/clients';
import { OAUTH_COOKIE, readSession, SESSION_COOKIE, sign, type OAuthState } from '$lib/server/auth';
import { GET } from '$routes/auth/callback/+server';

const h = vi.hoisted(() => ({
  getToken: vi.fn(),
  verifyIdToken: vi.fn(),
  addSecretVersion: vi.fn(),
  createSecret: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    getToken = h.getToken;
    verifyIdToken = h.verifyIdToken;
  },
}));

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    addSecretVersion = h.addSecretVersion;
    createSecret = h.createSecret;
  },
}));

type Event = Parameters<typeof GET>[0];

const state = (patch: Partial<OAuthState> = {}): OAuthState => ({
  nonce: 'nonce-1',
  purpose: 'sign-in',
  channel: null,
  ...patch,
});

async function call(opts: {
  cookie?: string;
  query?: string;
  allowlisted?: boolean | null;
  origin?: string;
}) {
  const cookies = {
    get: vi.fn((name: string) => (name === OAUTH_COOKIE ? opts.cookie : undefined)),
    set: vi.fn(),
    delete: vi.fn(),
  };
  const allowlisted = opts.allowlisted ?? null;
  const event = {
    url: new URL(
      `${opts.origin ?? 'http://localhost'}/auth/callback${opts.query ?? '?code=c1&state=nonce-1'}`,
    ),
    cookies,
    locals: {
      session: allowlisted === null ? null : { email: 'nathan@example.com', allowlisted },
    },
  } as unknown as Event;
  let thrown: unknown;
  try {
    await GET(event);
  } catch (error) {
    thrown = error;
  }
  return { thrown, cookies };
}

const google = (email: string, refreshToken: string | null = null, verified = true) => {
  h.getToken.mockResolvedValue({ tokens: { id_token: 'idt', refresh_token: refreshToken } });
  h.verifyIdToken.mockResolvedValue({ getPayload: () => ({ email, email_verified: verified }) });
};

const redirectTo = (thrown: unknown) =>
  isRedirect(thrown) ? [thrown.status, thrown.location] : thrown;
const statusOf = (thrown: unknown) => (isHttpError(thrown) ? thrown.status : thrown);

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'secret');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'client-1');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'shh');
  vi.stubEnv('GCP_PROJECT_ID', 'proj');
  vi.stubEnv('ALLOWLIST_EMAILS', 'nathan@example.com, ashley@example.com');
  resetClients();
  for (const fn of Object.values(h)) fn.mockReset();
});

describe('GET /auth/callback: state checks', () => {
  it('400s when the state does not match the cookie', async () => {
    const { thrown, cookies } = await call({
      cookie: sign(state()),
      query: '?code=c1&state=other',
    });
    expect(statusOf(thrown)).toBe(400);
    expect(cookies.delete).toHaveBeenCalledWith(OAUTH_COOKIE, { path: '/auth' });
    expect(h.getToken).not.toHaveBeenCalled();
  });

  it('400s without a state cookie', async () => {
    expect(statusOf((await call({})).thrown)).toBe(400);
  });

  it('400s a forged state cookie', async () => {
    const forged = sign(state()).replace(/\.[^.]+$/, '.bad');
    expect(statusOf((await call({ cookie: forged })).thrown)).toBe(400);
  });

  it('400s without a code', async () => {
    const { thrown } = await call({ cookie: sign(state()), query: '?state=nonce-1' });
    expect(statusOf(thrown)).toBe(400);
  });
});

describe('GET /auth/callback: sign-in', () => {
  it('sends a non-allowlisted account back with no session cookie', async () => {
    google('stranger@example.com');
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect(redirectTo(thrown)).toEqual([303, '/?signin=denied']);
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('sets a signed session cookie for an allowlisted account', async () => {
    google('Nathan@Example.com');
    const { thrown, cookies } = await call({
      cookie: sign(state()),
      origin: 'https://soundboard.run.app',
    });
    expect(redirectTo(thrown)).toEqual([303, '/']);
    expect(cookies.set).toHaveBeenCalledTimes(1);
    const [name, value, options] = cookies.set.mock.calls[0]!;
    expect(name).toBe(SESSION_COOKIE);
    expect(options).toMatchObject({ path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
    expect(readSession(value as string)).toEqual({
      email: 'nathan@example.com',
      allowlisted: true,
    });
    expect(h.getToken).toHaveBeenCalledWith('c1');
  });

  it('refuses an unverified Google email', async () => {
    google('nathan@example.com', null, false);
    const { thrown, cookies } = await call({ cookie: sign(state()) });
    expect((thrown as Error).message).toBe('Google account email is not verified');
    expect(cookies.set).not.toHaveBeenCalled();
  });
});

describe('GET /auth/callback: connect', () => {
  const connectState = () => sign(state({ purpose: 'connect', channel: 'nathan' }));

  it("stores the channel's refresh token for an allowlisted session", async () => {
    google('nathan@example.com', 'refresh-1');
    const { thrown, cookies } = await call({ cookie: connectState(), allowlisted: true });
    expect(redirectTo(thrown)).toEqual([303, '/?connected=nathan']);
    expect(h.addSecretVersion).toHaveBeenCalledWith({
      parent: 'projects/proj/secrets/yt-refresh-nathan',
      payload: { data: Buffer.from('refresh-1', 'utf8') },
    });
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('400s when Google returns no refresh token', async () => {
    google('nathan@example.com', null);
    const { thrown } = await call({ cookie: connectState(), allowlisted: true });
    expect(statusOf(thrown)).toBe(400);
    expect(h.addSecretVersion).not.toHaveBeenCalled();
  });

  it('403s a connect from a non-allowlisted session', async () => {
    google('nathan@example.com', 'refresh-1');
    expect(statusOf((await call({ cookie: connectState(), allowlisted: false })).thrown)).toBe(403);
    expect(statusOf((await call({ cookie: connectState() })).thrown)).toBe(403);
    expect(h.addSecretVersion).not.toHaveBeenCalled();
  });

  it('403s a connect state with no channel', async () => {
    google('nathan@example.com', 'refresh-1');
    const noChannel = sign(state({ purpose: 'connect', channel: null }));
    expect(statusOf((await call({ cookie: noChannel, allowlisted: true })).thrown)).toBe(403);
  });
});

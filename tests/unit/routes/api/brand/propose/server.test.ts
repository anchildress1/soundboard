// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { POST } from '#src/routes/api/brand/propose/+server.js';
import {
  busy429,
  GEMINI_INTERACTIONS,
  interaction,
  perDay429,
} from '../../../../../helpers/gemini';
import { seed, truncate } from '../../../../../helpers/db';
import {
  CHANNEL_A,
  REFRESH_A,
  USER_A,
  USER_B,
  USER_C,
  USERS,
} from '../../../../../helpers/pipeline';

vi.mock('@google-cloud/kms', () => import('../../../../../e2e/fakes/kms'));
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    refresh = '';
    setCredentials(credentials: { refresh_token: string }) {
      this.refresh = credentials.refresh_token;
    }
    async getAccessToken() {
      return { token: `access:${this.refresh}` };
    }
  },
}));

type Event = Parameters<typeof POST>[0];
const propose = (user: typeof USER_A | typeof USER_B | typeof USER_C | null) =>
  POST({ locals: { user } } as unknown as Event);

const fetchMock = vi.fn<typeof fetch>();

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** One public upload on the channel, then `model` answers the Gemini call. */
const channelThen = (model: () => Response) =>
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === GEMINI_INTERACTIONS) return model();
    if (url.includes('/channels?')) {
      return json({
        items: [{ id: CHANNEL_A, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }],
      });
    }
    if (url.includes('/playlistItems?')) {
      return json({ items: [{ contentDetails: { videoId: 'v1' } }] });
    }
    if (url.includes('/videos?')) {
      return json({ items: [{ id: 'v1', snippet: { title: 'Song' } }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

beforeEach(async () => {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'secret');
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  resetClients();
  await truncate();
  await seed(USERS);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/brand/propose', () => {
  it.each([
    ['signed out', null],
    ['a user without a profile', USER_B],
    ['a profile that is not curated', USER_C],
  ])('404s when %s without touching YouTube or the model', async (_label, user) => {
    const error = await Promise.resolve()
      .then(() => propose(user))
      .catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['busy', busy429, 'model busy'],
    ['out of quota for the day', perDay429, 'model quota spent'],
  ])('answers a wait while the model is %s', async (_label, model, wait) => {
    channelThen(model);
    const response = await propose(USER_A);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wait });
  });

  it("reads the uploads on the signed-in owner's own grant and stores a count", async () => {
    channelThen(() => interaction(JSON.stringify({ statement: 's', keep: [], fix: [], drop: [] })));
    const response = await propose(USER_A);
    const body = (await response.json()) as { proposal?: { uploadCount: number } };
    const reads = fetchMock.mock.calls.filter(([url]) => String(url).includes('youtube/v3'));
    for (const [, init] of reads) {
      expect((init!.headers as Record<string, string>).authorization).toBe(
        `Bearer access:${REFRESH_A}`,
      );
    }
    expect(body).toMatchObject({ proposal: { uploadCount: 1 } });
  });

  it('answers a reconnect wait when the owner has no connection, calling nothing', async () => {
    await truncate();
    await seed({ artists: USERS.artists, users: USERS.users });
    const response = await propose(USER_A);
    expect(await response.json()).toEqual({ wait: 'reconnect YouTube' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

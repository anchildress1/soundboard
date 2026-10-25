// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { POST } from '#src/routes/api/brand/propose/+server.js';
import { busy429, perDay429 } from '../../../../../helpers/gemini';
import { USER_A, USER_B } from '../../../../../helpers/pipeline';

type Event = Parameters<typeof POST>[0];
const propose = (user: typeof USER_A | typeof USER_B | null) =>
  POST({ locals: { user } } as unknown as Event);

const fetchMock = vi.fn<typeof fetch>();

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** One public upload on the channel, then `model` answers the Gemini call. */
const channelThen = (model: () => Response) =>
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('generativelanguage.googleapis.com')) return model();
    if (url.includes('/channels?')) {
      return json({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
    }
    if (url.includes('/playlistItems?')) {
      return json({ items: [{ contentDetails: { videoId: 'v1' } }] });
    }
    if (url.includes('/videos?')) {
      return json({ items: [{ id: 'v1', snippet: { title: 'Song' } }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

beforeEach(() => {
  vi.stubEnv('YOUTUBE_API_KEY', 'key');
  vi.stubEnv('FLR_CHANNEL_ID', 'UCflr');
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  resetClients();
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
    ['an unlinked user', USER_B],
  ])('404s when %s without touching the model', async (_label, user) => {
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
});

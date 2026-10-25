// @vitest-environment node
import { captureMessage } from '@sentry/sveltekit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { getConnection } from '#lib/server/platforms/youtube/index.js';
import { POST } from '#src/routes/api/connections/youtube/disconnect/+server.js';
import { seed, truncate } from '../../../../../../helpers/db';
import { REFRESH_A, USER_A, USER_B, USERS } from '../../../../../../helpers/pipeline';

vi.mock('@google-cloud/kms', () => import('../../../../../../e2e/fakes/kms'));

type Event = Parameters<typeof POST>[0];

const disconnect = async (user: typeof USER_A | typeof USER_B | null) =>
  POST({ locals: { user } } as unknown as Event);

const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  resetClients();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await truncate();
  await seed(USERS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/connections/youtube/disconnect', () => {
  it("revokes the caller's grant at Google, deletes the row and says Google confirmed", async () => {
    const response = await disconnect(USER_A);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revokedAtGoogle: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(String(init!.body)).toBe(`token=${REFRESH_A}`);
    expect(await getConnection(USER_A.uid)).toBeNull();
  });

  it('deletes the row even when Google refuses the revoke', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));
    const response = await disconnect(USER_A);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revokedAtGoogle: false });
    expect(captureMessage).toHaveBeenCalledWith('YouTube revoke refused', expect.anything());
    expect(await getConnection(USER_A.uid)).toBeNull();
  });

  it("leaves other users' connections alone, with nothing of the caller's to revoke", async () => {
    const response = await disconnect(USER_B);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revokedAtGoogle: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getConnection(USER_A.uid)).not.toBeNull();
  });

  it('401s signed out, revoking and deleting nothing', async () => {
    const response = await disconnect(null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: 'Sign in first.' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getConnection(USER_A.uid)).not.toBeNull();
  });
});

// @vitest-environment node
import { captureMessage } from '@sentry/sveltekit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { eq, sql } from 'drizzle-orm';
import { db, query } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { artistOutcomes, connections } from '#lib/server/core/schema.js';
import { ANALYTICS_SCOPE, getConnection } from '#lib/server/platforms/youtube/index.js';
import { POST } from '#src/routes/api/connections/youtube/disconnect/+server.js';
import { seed, truncate } from '../../../../../../helpers/db';
import { REFRESH_A, USER_A, USER_B, USER_C, USERS } from '../../../../../../helpers/pipeline';

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

describe('POST /api/connections/youtube/disconnect: analytics results', () => {
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
  const left = async () =>
    (await db().select({ videoId: artistOutcomes.videoId }).from(artistOutcomes))
      .map((row) => row.videoId)
      .toSorted();

  beforeEach(async () => {
    await db().execute(sql`select 1`);
    for (const user of [USER_A, USER_C]) {
      await db()
        .update(connections)
        .set({ scopes: ['openid', 'email', ANALYTICS_SCOPE] })
        .where(eq(connections.uid, user.uid));
    }
    await seed({
      artistOutcomes: [outcome(USER_A.artistId, 'va'), outcome(USER_C.artistId, 'vc')],
    });
  });

  it("deletes the caller's results with the connection, leaving other artists'", async () => {
    await disconnect(USER_A);
    expect(await left()).toEqual(['vc']);
    const seen = await withIdentity(USER_A.uid, () =>
      query((tx) => tx.select().from(artistOutcomes)),
    );
    expect(seen).toEqual([]);
  });

  it('deletes them even when Google refuses the revoke', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));
    await disconnect(USER_A);
    expect(await left()).toEqual(['vc']);
  });

  it('keeps them all when nobody is signed in', async () => {
    await disconnect(null);
    expect(await left()).toEqual(['va', 'vc']);
  });
});

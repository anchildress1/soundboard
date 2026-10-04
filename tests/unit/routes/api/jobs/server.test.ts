// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { POST } from '$routes/api/jobs/+server';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      return {
        file: (object: string) => ({
          getSignedUrl: async ({ action }: { action: string }) => [
            `https://storage.googleapis.com/${name}/${object}?sig=${action}`,
          ],
        }),
      };
    }
  },
}));

type Event = Parameters<typeof POST>[0];

const post = (body: unknown, allowlisted = false, ip = '203.0.113.7') =>
  POST({
    request: new Request('http://localhost/api/jobs', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    locals: { session: allowlisted ? { email: 'nathan@example.com', allowlisted: true } : null },
    getClientAddress: () => ip,
  } as unknown as Event);

const upload = {
  songTitle: 'PeekaBoo',
  notes: 'first single',
  filename: 'peekaboo.mp4',
  contentType: 'video/mp4',
  size: 5_000_000,
  durationSec: 200,
};

const jobKeys = () => [...store.keys()].filter((k) => /^jobs\/[^/]+$/.test(k));
const onlyJob = () => store.get(jobKeys()[0]!) as Record<string, unknown>;

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  vi.stubEnv('SESSION_SECRET', 'salt');
  resetStore();
  resetClients();
  store.set('samples/s1', {
    songTitle: 'Neon',
    videoId: 'live1',
    object: 'samples/neon.mp4',
    durationSec: 30,
  });
});

describe('POST /api/jobs', () => {
  it('starts a signed-out sample run on the sandbox channel', async () => {
    const response = await post({ sampleId: 's1' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; uploadUrl: string | null };
    expect(body.uploadUrl).toBeNull();
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(onlyJob()).toMatchObject({
      owner: 'visitor',
      channel: 'sandbox',
      state: 'PREP',
      sampleId: 's1',
      liveVideoId: 'live1',
    });
    expect(onlyJob().ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(onlyJob())).not.toContain('203.0.113.7');
  });

  it('hands an allowlisted upload a signed PUT URL and no run caps', async () => {
    const response = await post(upload, true);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; uploadUrl: string };
    expect(body.uploadUrl).toBe(`https://storage.googleapis.com/bkt/uploads/${body.id}?sig=write`);
    expect(onlyJob()).toMatchObject({ owner: 'nathan', channel: 'nathan', ipHash: null });
    expect([...store.keys()].some((k) => k.startsWith('quota/'))).toBe(false);
  });

  it('rejects a body that is not a JSON object', async () => {
    const response = await post('[]');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Expected a JSON object.',
      fields: null,
    });
    expect(jobKeys()).toHaveLength(0);
  });

  it('requires a song title', async () => {
    const response = await post({ ...upload, songTitle: '  ' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('Song title is required.');
  });

  it('caps visitor uploads at 5 minutes', async () => {
    const response = await post({ ...upload, durationSec: 301 });
    expect(response.status).toBe(400);
  });

  it('404s a missing sample', async () => {
    expect((await post({ sampleId: 'gone' })).status).toBe(404);
  });

  it('stops a visitor after five runs a day', async () => {
    for (let i = 0; i < 5; i++) expect((await post({ sampleId: 's1' })).status).toBe(200);
    const response = await post({ sampleId: 's1' });
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: string }).error).toMatch(/5 runs per visitor/);
    expect((await post({ sampleId: 's1' }, false, '198.51.100.1')).status).toBe(200);
  });
});

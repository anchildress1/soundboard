// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { load } from '$routes/jobs/[id]/+page.server';
import type { JobView, LiveMetadata } from '$lib/types';

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

type Event = Parameters<typeof load>[0];
type Data = {
  view: JobView;
  playbackUrl: string | null;
  live: LiveMetadata | null;
  trace: { sentryTrace: string; baggage: string } | null;
};

const TRACE = { sentryTrace: 'abc-def-1', baggage: 'sentry-trace_id=abc' };

async function run(id: string, allowlisted = false) {
  const locals: App.Locals = {
    session: allowlisted ? { email: 'nathan@example.com', allowlisted } : null,
  };
  const data = (await load({ params: { id }, locals } as unknown as Event)) as Data;
  return { data, locals };
}

function seed(id: string, patch: Record<string, unknown> = {}) {
  store.set(`jobs/${id}`, {
    id,
    owner: 'visitor',
    state: 'ANALYZE',
    object: `uploads/${id}`,
    liveVideoId: null,
    trace: TRACE,
    ...patch,
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  vi.stubEnv('YOUTUBE_API_KEY', 'key');
  resetStore();
  resetClients();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('job page load', () => {
  it("hands the job's trace to the hooks and streams playback from GCS", async () => {
    seed('j');
    const { data, locals } = await run('j');
    expect(locals.jobTrace).toEqual(TRACE);
    expect(data.trace).toEqual(TRACE);
    expect(data.view.job.id).toBe('j');
    expect(data.view.job).not.toHaveProperty('trace');
    expect(data.playbackUrl).toBe('https://storage.googleapis.com/bkt/uploads/j?sig=read');
    expect(data.live).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips playback while the browser upload is still running', async () => {
    seed('j', { state: 'AWAITING_UPLOAD', trace: null });
    const { data, locals } = await run('j');
    expect(data.playbackUrl).toBeNull();
    expect(locals.jobTrace).toBeNull();
  });

  it("loads a sample's live metadata for the diff", async () => {
    seed('j', { liveVideoId: 'live1' });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: 'live1',
              snippet: { title: 'Neon', description: 'Out now #synthwave', tags: ['synthwave'] },
            },
          ],
        }),
      ),
    );
    const { data } = await run('j');
    expect(data.live).toEqual({
      videoId: 'live1',
      title: 'Neon',
      description: 'Out now #synthwave',
      tags: ['synthwave'],
    });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('id')).toBe('live1');
  });

  it('drops the diff when the live video is gone', async () => {
    seed('j', { liveVideoId: 'live1' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [] })));
    expect((await run('j')).data.live).toBeNull();
  });

  it('drops the diff when YouTube is unreachable', async () => {
    seed('j', { liveVideoId: 'live1' });
    fetchMock.mockRejectedValue(new Error('offline'));
    expect((await run('j')).data.live).toBeNull();
  });

  it("404s Nathan's job for a non-allowlisted session without touching locals", async () => {
    seed('n', { owner: 'nathan' });
    const locals: App.Locals = { session: null };
    const error = await Promise.resolve(
      load({ params: { id: 'n' }, locals } as unknown as Event),
    ).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(locals.jobTrace).toBeUndefined();
  });

  it("serves Nathan's job to an allowlisted session", async () => {
    seed('n', { owner: 'nathan' });
    expect((await run('n', true)).data.view.job.owner).toBe('nathan');
  });
});

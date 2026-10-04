// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { POST } from '$routes/api/jobs/[id]/short/+server';
import type { JobView } from '$lib/types';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

type Event = Parameters<typeof POST>[0];

const make = async (id: string, allowlisted = false) =>
  POST({
    params: { id },
    locals: { session: allowlisted ? { email: 'nathan@example.com', allowlisted } : null },
  } as unknown as Event);

const PROBE = { durationSec: 180, width: 1920, height: 1080, hasAudio: true };

function seed(id: string, patch: Record<string, unknown> = {}) {
  store.set(`jobs/${id}`, {
    id,
    owner: 'visitor',
    channel: 'sandbox',
    state: 'REVIEW',
    songTitle: 'PeekaBoo',
    notes: '',
    filename: 'peekaboo.mp4',
    object: `uploads/${id}`,
    probe: PROBE,
    hashtagCandidates: ['#synthwave'],
    finalFields: null,
    shortId: null,
    trace: { sentryTrace: 't', baggage: 'b' },
    ...patch,
  });
  store.set(`jobs/${id}/pick/0001`, { version: 1, title: 'First', skipped: false });
}

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
});

describe('POST /api/jobs/[id]/short', () => {
  it("starts the video's Short and answers with the Short's view", async () => {
    seed('j');
    const response = await make('j');
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job.state).toBe('HOOK');
    expect(view.job.short).toMatchObject({ parentId: 'j', reframe: 'blur', hook: null });
    expect(view.pick).toMatchObject({ version: 1, title: 'First' });
    expect(view).not.toHaveProperty('playbackUrl');
    expect((store.get('jobs/j') as { shortId: string }).shortId).toBe(view.job.id);
  });

  it('answers with the same Short on a second press', async () => {
    seed('j');
    const first = (await (await make('j')).json()) as JobView;
    const second = (await (await make('j')).json()) as JobView;
    expect(second.job.id).toBe(first.job.id);
  });

  it('409s while the video is still being analyzed', async () => {
    seed('j', { state: 'ANALYZE' });
    const response = await make('j');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Not allowed while the job is ANALYZE.',
      fields: null,
    });
  });

  it("404s Nathan's video for a non-allowlisted session", async () => {
    seed('n', { owner: 'nathan', channel: 'nathan' });
    const error = await make('n').catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(
      [...store.keys()].filter((k) => k.startsWith('jobs/') && k.split('/').length === 2),
    ).toEqual(['jobs/n']);
  });

  it("starts Nathan's Short for an allowlisted session, owned like the video", async () => {
    seed('n', { owner: 'nathan', channel: 'nathan' });
    const view = (await (await make('n', true)).json()) as JobView;
    expect(view.job).toMatchObject({ owner: 'nathan', channel: 'nathan' });
  });

  it('404s an unknown job', async () => {
    const error = await make('ghost').catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
  });

  it('fails loudly if the Short vanishes right after it is created', async () => {
    seed('j');
    const real = store.set.bind(store);
    vi.spyOn(store, 'set').mockImplementation((key: string, value) =>
      /^jobs\/[^/]+$/.test(key) && key !== 'jobs/j' ? store : real(key, value),
    );
    await expect(make('j')).rejects.toThrow(/vanished after it was created/);
    vi.restoreAllMocks();
  });
});

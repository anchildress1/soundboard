// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { POST } from '$routes/api/jobs/[id]/approve/+server';
import type { JobView } from '$lib/types';

const SYNTHWAVE = '#synthwave';

const h = vi.hoisted(() => ({ secrets: new Map<string, string>() }));

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    async accessSecretVersion({ name }: { name: string }) {
      const value = h.secrets.get(name.split('/')[3]!);
      if (value === undefined) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
      return [{ payload: { data: Buffer.from(value) } }];
    }
  },
}));

type Event = Parameters<typeof POST>[0];

const approve = async (id: string, body: unknown, allowlisted = false) =>
  POST({
    params: { id },
    request: new Request(`http://localhost/api/jobs/${id}/approve`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    locals: { session: allowlisted ? { email: 'nathan@example.com', allowlisted } : null },
  } as unknown as Event);

const CANDIDATES = [SYNTHWAVE, '#RetroWave', '#newmusic'];

function seed(id: string, patch: Record<string, unknown> = {}) {
  store.set(`jobs/${id}`, {
    id,
    owner: 'visitor',
    channel: null,
    state: 'REVIEW',
    songTitle: 'PeekaBoo',
    hashtagCandidates: CANDIDATES,
    consecutiveFailures: 0,
    audience: {
      query: 'synthwave music video',
      hashtags: CANDIDATES,
      tags: ['synthwave', 'outrun', '42'].map((tag) => ({ tag, usedBy: 1 })),
      top: [],
    },
    pickVersion: 1,
    ...patch,
  });
  store.set(`jobs/${id}/pick/0001`, {
    version: 1,
    title: 'PeekaBoo',
    description: 'Night drive. #synthwave',
    hashtags: [SYNTHWAVE],
    tags: ['synthwave'],
    flags: [],
    brandCheck: '',
    why: { title: '', description: '', tags: '' },
    bandcamp: { about: 'Bandcamp about.', credits: 'Written by Nathan.' },
    modelMs: 1,
    skipped: false,
  });
}

const job = (id: string) => store.get(`jobs/${id}`) as Record<string, unknown>;
const fields = {
  title: 'PeekaBoo (Official Video)',
  description: 'Night drive. #synthwave #retrowave',
  tags: 'synthwave, outrun',
  pickVersion: 1,
};

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
  h.secrets.clear();
});

describe('POST /api/jobs/[id]/approve', () => {
  it('ends a signed-out own-video run at the would-be payload', async () => {
    seed('j');
    const response = await approve('j', fields);
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job.state).toBe('PAYLOAD');
    expect(view.job.payload).toEqual({
      title: 'PeekaBoo (Official Video)',
      description: 'Night drive. #synthwave #retrowave',
      hashtags: [SYNTHWAVE, '#RetroWave'],
      tags: ['synthwave', 'outrun'],
    });
    // Visitor feedback stays on the job.
    expect([...store.keys()].some((k) => k.startsWith('jobs/j/feedback/'))).toBe(true);
    expect([...store.keys()].some((k) => k.startsWith('artists/'))).toBe(false);
  });

  it('accepts tags as an array', async () => {
    seed('j');
    await approve('j', { ...fields, tags: ['synthwave', 42] });
    expect((job('j').payload as { tags: string[] }).tags).toEqual(['synthwave', '42']);
  });

  it('drops array tags that are not text', async () => {
    seed('j');
    await approve('j', { ...fields, tags: ['synthwave', { tag: 'outrun' }, null] });
    expect((job('j').payload as { tags: string[] }).tags).toEqual(['synthwave']);
  });

  it('reads an object title as empty rather than "[object Object]"', async () => {
    seed('j');
    const response = await approve('j', { ...fields, title: { text: 'PeekaBoo' } });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ fields: { title: 'Title is required.' } });
  });

  it('400s a recommendation version sent as a string', async () => {
    seed('j');
    const response = await approve('j', { ...fields, pickVersion: '1' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Name the recommendation version being approved.',
    });
  });

  it('treats missing fields as empty and reports the title', async () => {
    seed('j');
    const response = await approve('j', {});
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ fields: { title: 'Title is required.' } });
  });

  it('rejects a hashtag outside the candidate list with field errors', async () => {
    seed('j');
    const response = await approve('j', { ...fields, description: 'x #madeup' });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Fix the highlighted fields.',
      fields: { description: "Not in this job's hashtag list: #madeup" },
    });
    expect(job('j').state).toBe('REVIEW');
  });

  it('409s outside review', async () => {
    seed('j', { state: 'ANALYZE' });
    const response = await approve('j', fields);
    expect(response.status).toBe(409);
  });

  it('400s a malformed body', async () => {
    seed('j');
    expect((await approve('j', '{oops')).status).toBe(400);
  });

  it('queues the upload when the channel is connected and quota remains', async () => {
    seed('j', { channel: 'sandbox', sampleId: 's1' });
    h.secrets.set('yt-refresh-sandbox', 'rt');
    const view = (await (await approve('j', fields)).json()) as JobView;
    expect(view.job.state).toBe('PUBLISHING');
  });

  it("404s Nathan's job from a non-allowlisted session and changes nothing", async () => {
    seed('n', { owner: 'nathan', channel: 'nathan' });
    const error = await approve('n', fields).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(job('n').state).toBe('REVIEW');
    expect([...store.keys()].some((k) => k.includes('feedback'))).toBe(false);
  });

  it("records Nathan's approval on the artist for an allowlisted session", async () => {
    seed('n', { owner: 'nathan', channel: 'nathan' });
    const view = (await (await approve('n', fields, true)).json()) as JobView;
    expect(view.job.state).toBe('PAYLOAD');
    expect(view.job.error).toBe('The upload channel is not connected.');
    expect([...store.keys()].some((k) => k.startsWith('artists/flr/feedback/'))).toBe(true);
  });
});

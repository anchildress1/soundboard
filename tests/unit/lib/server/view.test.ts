// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { createJob, saveChunk, savePick, type NewJob } from '$lib/server/jobs';
import { authorizedJob, buildView } from '$lib/server/view';
import type { Chunk, JobState, Pick, Short } from '$lib/types';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      return {
        file: (object: string) => ({
          getSignedUrl: async () => [`https://storage.googleapis.com/${name}/${object}?sig=read`],
        }),
      };
    }
  },
}));

const SHORT: Short = {
  parentId: 'v',
  sourceDurationSec: 180,
  reframe: 'blur',
  hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'x' },
  skipped: [],
  renders: 1,
  modelMs: 1,
};

const input = (owner: NewJob['owner']): NewJob => ({
  owner,
  channel: owner === 'nathan' ? 'nathan' : null,
  songTitle: 'PeekaBoo',
  notes: '',
  filename: 'peekaboo.mp4',
  contentType: 'video/mp4',
  object: null,
  sampleId: null,
  liveVideoId: null,
  ipHash: 'hash',
  trace: { sentryTrace: 't', baggage: 'b' },
});

const chunk = (index: number): Chunk => ({
  index,
  startSec: index * 29.5,
  durationSec: 29.5,
  measurements: {
    integratedLufs: -14,
    truePeakDbtp: -1,
    peakLevelDb: -1,
    clippedSamples: 0,
    silences: [],
  },
  analysis: null,
  raw: 'x',
  modelMs: 10,
});

const pick = (version: number): Pick => ({
  version,
  title: `T${version}`,
  description: 'd',
  hashtags: [],
  tags: [],
  flags: [],
  brandCheck: '',
  why: { title: '', description: '', tags: '' },
  bandcamp: { about: 'Bandcamp about.', credits: 'Written by Nathan.' },
  modelMs: 1,
});

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  resetStore();
  resetClients();
});

async function status(promise: Promise<unknown>): Promise<number | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isHttpError(error) ? error.status : -1;
  }
}

describe('authorizedJob', () => {
  it('returns a visitor job to anyone holding its ID', async () => {
    await createJob(input('visitor'), 'v');
    expect((await authorizedJob('v', false)).id).toBe('v');
  });

  it("returns Nathan's job to an allowlisted session", async () => {
    await createJob(input('nathan'), 'n');
    expect((await authorizedJob('n', true)).owner).toBe('nathan');
  });

  it("reads Nathan's job as missing to anyone else", async () => {
    await createJob(input('nathan'), 'n');
    expect(await status(authorizedJob('n', false))).toBe(404);
  });

  it('404s an unknown job', async () => {
    expect(await status(authorizedJob('ghost', true))).toBe(404);
  });
});

describe('buildView', () => {
  it('bundles the public job, its chunks, and the latest pick', async () => {
    const job = await createJob(input('visitor'), 'v');
    await saveChunk('v', chunk(1));
    await saveChunk('v', chunk(0));
    await savePick('v', pick(1));
    await savePick('v', pick(2));
    const view = await buildView(job);
    expect(view.job.id).toBe('v');
    expect(view.job).not.toHaveProperty('trace');
    expect(view.job).not.toHaveProperty('ipHash');
    expect(view.chunks.map((c) => c.index)).toEqual([0, 1]);
    expect(view.pick?.version).toBe(2);
    expect(view).not.toHaveProperty('wait');
  });

  it('carries a wait reason when given one', async () => {
    const job = await createJob(input('visitor'), 'v');
    const view = await buildView(job, 'waking model');
    expect(view.wait).toBe('waking model');
    expect(view.pick).toBeNull();
    expect(view.chunks).toEqual([]);
  });

  it('reads only the job it was given', async () => {
    const job = await createJob(input('visitor'), 'v');
    await createJob(input('visitor'), 'other');
    await saveChunk('other', chunk(0));
    expect((await buildView(job)).chunks).toEqual([]);
    expect(store.has('jobs/other/chunks/0000')).toBe(true);
  });
});

describe('buildView for a Short', () => {
  it.each(['REVIEW', 'PUBLISHING', 'CLAIMED_COMPLETE', 'VERIFIED', 'PAYLOAD'] as JobState[])(
    'signs playback of the rendered object in %s',
    async (state) => {
      const job = await createJob(input('visitor'), 's');
      const view = await buildView({ ...job, state, object: 'uploads/s-1', short: SHORT });
      expect(view.playbackUrl).toBe('https://storage.googleapis.com/bkt/uploads/s-1?sig=read');
    },
  );

  it.each(['HOOK', 'RENDER', 'FAILED'] as JobState[])(
    'leaves playback out while the Short is %s',
    async (state) => {
      const job = await createJob(input('visitor'), 's');
      expect(await buildView({ ...job, state, short: SHORT })).not.toHaveProperty('playbackUrl');
    },
  );

  it('leaves playback out before the first render', async () => {
    const job = await createJob(input('visitor'), 's');
    const view = await buildView({ ...job, state: 'REVIEW', short: { ...SHORT, renders: 0 } });
    expect(view).not.toHaveProperty('playbackUrl');
  });

  it('never signs playback for a video job', async () => {
    const job = await createJob(input('visitor'), 'v');
    expect(await buildView({ ...job, state: 'REVIEW' })).not.toHaveProperty('playbackUrl');
  });
});

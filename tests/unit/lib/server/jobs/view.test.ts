// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import { createJob, listChunks, type NewJob } from '$lib/server/jobs/jobs';
import { authorizedJob, buildView } from '$lib/server/jobs/view';
import type { Chunk, JobState, Pick, Short } from '$lib/types';
import { seed, truncate } from '../../../../helpers/db';
import { USER_A, USER_B, USERS } from '../../../../helpers/pipeline';

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
  sourceDurationSec: 180,
  reframe: 'blur',
  hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'x' },
  skipped: [],
  renders: 1,
  modelMs: 1,
};

const input = (ownerUid: string = USER_B.uid): NewJob => ({
  ownerUid,
  artistId: null,
  songTitle: 'PeekaBoo',
  notes: '',
  filename: 'peekaboo.mp4',
  contentType: 'video/mp4',
  object: null,
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

const seedChunks = (jobId: string, ...indexes: number[]) =>
  seed({ jobChunks: indexes.map((i) => ({ jobId, index: i, data: chunk(i) })) });
const seedPicks = (jobId: string, ...versions: number[]) =>
  seed({
    jobPicks: versions.map((v) => ({ jobId, version: v, data: { ...pick(v), skipped: false } })),
  });

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  resetClients();
  await truncate();
  await seed(USERS);
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
  it('returns the job to its owner', async () => {
    await createJob(input(USER_A.uid), 'a');
    expect((await authorizedJob('a', USER_A.uid)).ownerUid).toBe(USER_A.uid);
  });

  it("reads another user's job as missing", async () => {
    await createJob(input(USER_A.uid), 'a');
    expect(await status(authorizedJob('a', USER_B.uid))).toBe(404);
  });

  it('reads every job as missing when signed out', async () => {
    await createJob(input(USER_A.uid), 'a');
    expect(await status(authorizedJob('a', undefined))).toBe(404);
  });

  it('404s an unknown job', async () => {
    expect(await status(authorizedJob('ghost', USER_A.uid))).toBe(404);
  });
});

describe('buildView', () => {
  it('bundles the public job, its chunks, and the latest pick', async () => {
    const job = await createJob(input(), 'v');
    await seedChunks('v', 1, 0);
    await seedPicks('v', 1, 2);
    const view = await buildView(job);
    expect(view.job.id).toBe('v');
    expect(view.job).not.toHaveProperty('trace');
    expect(view.job).not.toHaveProperty('ownerUid');
    expect(view.chunks.map((c) => c.index)).toEqual([0, 1]);
    expect(view.pick?.version).toBe(2);
    expect(view).not.toHaveProperty('wait');
  });

  it('carries a wait reason when given one', async () => {
    const job = await createJob(input(), 'v');
    const view = await buildView(job, 'waking model');
    expect(view.wait).toBe('waking model');
    expect(view.pick).toBeNull();
    expect(view.chunks).toEqual([]);
  });

  it('reads only the job it was given', async () => {
    const job = await createJob(input(), 'v');
    await createJob(input(), 'other');
    await seedChunks('other', 0);
    expect((await buildView(job)).chunks).toEqual([]);
    expect(await listChunks('other')).toHaveLength(1);
  });
});

describe('buildView for a Short', () => {
  it.each(['REVIEW', 'PUBLISHING', 'CLAIMED_COMPLETE', 'VERIFIED'] as JobState[])(
    'signs playback of the rendered object in %s',
    async (state) => {
      const job = await createJob(input(), 's');
      const view = await buildView({ ...job, state, object: 'uploads/s-1', short: SHORT });
      expect(view.playbackUrl).toBe('https://storage.googleapis.com/bkt/uploads/s-1?sig=read');
    },
  );

  it.each(['HOOK', 'RENDER', 'FAILED'] as JobState[])(
    'leaves playback out while the Short is %s',
    async (state) => {
      const job = await createJob(input(), 's');
      expect(await buildView({ ...job, state, short: SHORT })).not.toHaveProperty('playbackUrl');
    },
  );

  it('leaves playback out before the first render', async () => {
    const job = await createJob(input(), 's');
    const view = await buildView({ ...job, state: 'REVIEW', short: { ...SHORT, renders: 0 } });
    expect(view).not.toHaveProperty('playbackUrl');
  });

  it('never signs playback for a video job', async () => {
    const job = await createJob(input(), 'v');
    expect(await buildView({ ...job, state: 'REVIEW' })).not.toHaveProperty('playbackUrl');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../helpers/fake-firestore';
import {
  canAccess,
  claimJob,
  CLAIM_TTL_MS,
  createJob,
  fail,
  getJob,
  latestPick,
  listChunks,
  listPicks,
  skipAndRepick,
  transitionJob,
  newJobId,
  releaseJob,
  saveChunk,
  savePick,
  toPublic,
  updateJob,
  type NewJob,
} from '$lib/server/jobs';
import { resetClients } from '$lib/server/clients';
import type { Chunk, Pick } from '$lib/types';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

const input: NewJob = {
  owner: 'visitor',
  channel: null,
  songTitle: 'PeekaBoo',
  notes: '',
  filename: 'peekaboo.mp4',
  contentType: 'video/mp4',
  object: null,
  sampleId: null,
  liveVideoId: null,
  ipHash: 'abc',
  trace: { sentryTrace: 't-s-1', baggage: 'b' },
};

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
  modelMs: 1,
});

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
});

describe('newJobId', () => {
  it('is 128 random bits in base64url', () => {
    const id = newJobId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newJobId()).not.toBe(id);
  });
});

describe('createJob', () => {
  it('waits for the browser upload when no object exists yet', async () => {
    const job = await createJob(input, 'job1');
    expect(job.state).toBe('AWAITING_UPLOAD');
    expect(job.object).toBe('uploads/job1');
    expect(store.has('jobs/job1')).toBe(true);
  });

  it('starts at PREP for samples that already sit in the bucket', async () => {
    const job = await createJob({ ...input, object: 'samples/a.mp4' }, 'job2');
    expect(job.state).toBe('PREP');
    expect(job.object).toBe('samples/a.mp4');
  });
});

describe('getJob / updateJob', () => {
  it('returns null for a missing job', async () => {
    expect(await getJob('nope')).toBeNull();
  });

  it('merges a patch and bumps updatedAt', async () => {
    await createJob(input, 'j');
    await updateJob('j', { state: 'ANALYZE' });
    expect((await getJob('j'))?.state).toBe('ANALYZE');
  });
});

describe('claimJob / releaseJob', () => {
  it('hands out one claim at a time', async () => {
    await createJob(input, 'j');
    const token = await claimJob('j', 1000);
    expect(token).toBeTruthy();
    expect(await claimJob('j', 2000)).toBeNull();
  });

  it('frees the job once the claim lapses', async () => {
    await createJob(input, 'j');
    await claimJob('j', 1000);
    expect(await claimJob('j', 1000 + CLAIM_TTL_MS + 1)).toBeTruthy();
  });

  it('returns null for a missing job', async () => {
    expect(await claimJob('ghost')).toBeNull();
  });

  it('returns the job as read inside the claim', async () => {
    await createJob({ ...input, object: 'samples/a.mp4' }, 'j');
    const claimed = await claimJob('j');
    expect(claimed?.job.state).toBe('PREP');
    expect(claimed?.token).toMatch(/^[0-9a-f]{16}$/);
  });

  it('applies the patch and clears the claim for the holder', async () => {
    await createJob(input, 'j');
    const { token } = (await claimJob('j'))!;
    expect(await releaseJob('j', token, 'AWAITING_UPLOAD', { state: 'PICK' })).toBe(true);
    const job = await getJob('j');
    expect(job?.state).toBe('PICK');
    expect(job?.claim).toBeNull();
  });

  it('drops the patch but frees the job when an action moved it during the step', async () => {
    await createJob(input, 'j');
    const { token } = (await claimJob('j'))!;
    await updateJob('j', { state: 'DISCARDED' });
    expect(await releaseJob('j', token, 'AWAITING_UPLOAD', { state: 'PICK' })).toBe(false);
    const job = await getJob('j');
    expect(job?.state).toBe('DISCARDED');
    expect(job?.claim).toBeNull();
  });

  it('refuses a stale token', async () => {
    await createJob(input, 'j');
    await claimJob('j');
    expect(await releaseJob('j', 'stale', 'AWAITING_UPLOAD', { state: 'PICK' })).toBe(false);
    expect((await getJob('j'))?.state).toBe('AWAITING_UPLOAD');
  });

  it('refuses a missing job', async () => {
    expect(await releaseJob('ghost', 't', 'PREP')).toBe(false);
  });
});

describe('transitionJob', () => {
  it('moves the job only from an allowed state', async () => {
    await createJob(input, 'j');
    expect(await transitionJob('j', ['REVIEW'], { state: 'DISCARDED' })).toBe(false);
    expect(await transitionJob('j', ['AWAITING_UPLOAD'], { state: 'PREP' })).toBe(true);
    expect((await getJob('j'))?.state).toBe('PREP');
  });

  it('refuses a missing job', async () => {
    expect(await transitionJob('ghost', ['PREP'], { state: 'ANALYZE' })).toBe(false);
  });
});

describe('chunks and picks', () => {
  it('lists chunks in index order', async () => {
    await createJob(input, 'j');
    await saveChunk('j', chunk(1));
    await saveChunk('j', chunk(0));
    expect((await listChunks('j')).map((c) => c.index)).toEqual([0, 1]);
  });

  it('tracks pick versions and skips', async () => {
    await createJob(input, 'j');
    await updateJob('j', { state: 'REVIEW' });
    expect(await latestPick('j')).toBeNull();
    await savePick('j', pick(1));
    await savePick('j', pick(2));
    expect(await skipAndRepick('j', 1)).toBe(true);
    expect((await getJob('j'))?.state).toBe('PICK');
    expect(await skipAndRepick('j', 2)).toBe(false);
    const picks = await listPicks('j');
    expect(picks.map((p) => [p.version, p.skipped])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect((await latestPick('j'))?.version).toBe(2);
  });
});

describe('skipAndRepick', () => {
  it('queues a pick with nothing to skip', async () => {
    await createJob(input, 'j');
    await updateJob('j', { state: 'REVIEW' });
    expect(await skipAndRepick('j', null)).toBe(true);
    expect((await getJob('j'))?.state).toBe('PICK');
  });

  it('refuses a missing job', async () => {
    expect(await skipAndRepick('ghost', 1)).toBe(false);
  });
});

describe('toPublic', () => {
  it('drops server-only fields', async () => {
    const job = await createJob(input, 'j');
    const pub = toPublic({
      ...job,
      upload: { sessionUri: 'secret', total: 1 },
      claim: { token: 't', until: 1 },
    });
    expect(pub).not.toHaveProperty('upload');
    expect(pub).not.toHaveProperty('claim');
    expect(pub).not.toHaveProperty('ipHash');
    expect(pub).not.toHaveProperty('trace');
    expect(pub.songTitle).toBe('PeekaBoo');
  });
});

describe('canAccess', () => {
  it('lets anyone holding the ID see a visitor job', () => {
    expect(canAccess({ owner: 'visitor' }, false)).toBe(true);
  });

  it('lets anyone holding the ID see a demo job', () => {
    expect(canAccess({ owner: 'demo' }, false)).toBe(true);
  });

  it("keeps Nathan's jobs to allowlisted sessions", () => {
    expect(canAccess({ owner: 'nathan' }, false)).toBe(false);
    expect(canAccess({ owner: 'nathan' }, true)).toBe(true);
  });
});

describe('fail', () => {
  it('records the failed state for a retry', () => {
    expect(fail('ANALYZE', 'boom')).toEqual({
      state: 'FAILED',
      failedState: 'ANALYZE',
      error: 'boom',
    });
  });
});

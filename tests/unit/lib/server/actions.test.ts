// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../helpers/fake-firestore';
import { ActionError, approve, discard, rerun, retry } from '$lib/server/actions';
import { resetClients } from '$lib/server/clients';
import {
  createJob,
  getJob,
  listPicks,
  savePick,
  updateJob,
  type JobDoc,
  type NewJob,
} from '$lib/server/jobs';
import { quotaDay, UPLOADS_PER_DAY, VISITOR_UPLOADS_PER_DAY } from '$lib/server/quota';
import type { Channel, JobOwner, JobState, Pick } from '$lib/types';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

const sm = vi.hoisted(() => ({ accessSecretVersion: vi.fn() }));

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    accessSecretVersion = sm.accessSecretVersion;
  },
}));

const candidates = ['#synthwave', '#retrowave', '#NewMusic'];

const pick = (version: number, title = `Title ${version}`): Pick => ({
  version,
  title,
  description: 'A bright synth track.\n\n#synthwave #retrowave',
  hashtags: ['#synthwave', '#retrowave'],
  tags: ['synthwave', 'PeekaBoo'],
  flags: [],
  brandCheck: '',
  why: { title: '', description: '', tags: '' },
  modelMs: 1,
});

const base: NewJob = {
  owner: 'visitor',
  channel: 'sandbox',
  songTitle: 'PeekaBoo',
  notes: '',
  filename: 'p.mp4',
  contentType: 'video/mp4',
  object: 'samples/p.mp4',
  sampleId: 'p',
  liveVideoId: 'yt-p',
  ipHash: null,
  trace: null,
};

async function makeJob(
  opts: {
    owner?: JobOwner;
    channel?: Channel;
    state?: JobState;
    picks?: number;
    patch?: Partial<JobDoc>;
  } = {},
): Promise<JobDoc> {
  const id = 'job1';
  await createJob(
    {
      ...base,
      owner: opts.owner ?? 'visitor',
      channel: opts.channel === undefined ? 'sandbox' : opts.channel,
    },
    id,
  );
  for (let v = 1; v <= (opts.picks ?? 1); v++) await savePick(id, pick(v));
  const picks = opts.picks ?? 1;
  await updateJob(id, {
    state: opts.state ?? 'REVIEW',
    hashtagCandidates: candidates,
    pickVersion: picks > 0 ? picks : null,
    ...opts.patch,
  });
  return (await getJob(id))!;
}

const input = (
  over: Partial<{ title: string; description: string; tags: string[]; pickVersion: number }> = {},
) => ({
  title: 'Title 1',
  description: 'A bright synth track.\n\n#synthwave #retrowave',
  tags: ['synthwave', 'PeekaBoo'],
  pickVersion: 1,
  ...over,
});

const feedbackRows = (prefix: string) =>
  [...store.entries()]
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v as Record<string, unknown>);

const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ActionError);
  return error as ActionError;
};

const connected = () =>
  sm.accessSecretVersion.mockResolvedValue([{ payload: { data: new TextEncoder().encode('rt') } }]);

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
  vi.clearAllMocks();
  sm.accessSecretVersion.mockReset();
});

describe('ActionError', () => {
  it('carries status, message, and field errors', () => {
    const error = new ActionError(422, 'bad', { title: 'x' });
    expect(error).toBeInstanceOf(Error);
    expect([error.status, error.message, error.fields]).toEqual([422, 'bad', { title: 'x' }]);
    expect(new ActionError(400, 'm').fields).toBeUndefined();
  });
});

describe('approve', () => {
  it('requires REVIEW', async () => {
    const job = await makeJob({ state: 'ANALYZE' });
    const error = await rejection(approve(job, input()));
    expect(error.status).toBe(409);
    expect(error.message).toBe('Not allowed while the job is ANALYZE.');
  });

  it('refuses an approval with no recommendation on the job', async () => {
    connected();
    const job = await makeJob({ picks: 0 });
    const error = await rejection(approve(job, input()));
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/newer recommendation/);
  });

  it('refuses an approval that names an older pick', async () => {
    connected();
    const job = await makeJob({ picks: 2 });
    const error = await rejection(approve(job, input({ pickVersion: 1 })));
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/newer recommendation/);
    expect((await getJob('job1'))!.state).toBe('REVIEW');
    expect(feedbackRows('jobs/job1/feedback/')).toHaveLength(0);
  });

  it('refuses an approval with no pick version', async () => {
    const job = await makeJob();
    expect((await rejection(approve(job, input({ pickVersion: Number.NaN })))).status).toBe(400);
  });

  it('refuses when the job names a pick version that was never stored', async () => {
    connected();
    const job = await makeJob({ patch: { pickVersion: 7 } });
    expect((await rejection(approve(job, input({ pickVersion: 7 })))).status).toBe(409);
  });

  it('rejects a stray hashtag with 422 field errors and records nothing', async () => {
    const job = await makeJob();
    const error = await rejection(approve(job, input({ description: 'Out now #invented' })));
    expect(error.status).toBe(422);
    expect(error.fields).toEqual({ description: "Not in this job's hashtag list: #invented" });
    expect(feedbackRows('jobs/job1/feedback/')).toHaveLength(0);
    expect((await getJob('job1'))!.state).toBe('REVIEW');
  });

  it('rejects any hashtag when the job has no candidates', async () => {
    const job = await makeJob({ patch: { hashtagCandidates: null } });
    const error = await rejection(approve(job, input()));
    expect(error.status).toBe(422);
    expect(error.fields?.description).toContain('#synthwave');
  });

  it('reports title and tags errors together', async () => {
    const job = await makeJob();
    const error = await rejection(
      approve(job, input({ title: ' ', tags: Array.from({ length: 100 }, () => 'long tag') })),
    );
    expect(Object.keys(error.fields!).sort()).toEqual(['tags', 'title']);
  });

  it('ends at the payload when the job has no channel', async () => {
    const job = await makeJob({ channel: null });
    await approve(job, input({ title: '  Title 1  ' }));
    const after = (await getJob('job1'))!;
    expect(after.state).toBe('PAYLOAD');
    expect(after.payload).toEqual({
      title: 'Title 1',
      description: 'A bright synth track.\n\n#synthwave #retrowave',
      hashtags: ['#synthwave', '#retrowave'],
      tags: ['synthwave', 'PeekaBoo'],
    });
    expect(after.finalFields).toEqual(after.payload);
    expect(sm.accessSecretVersion).not.toHaveBeenCalled();
  });

  it('ends at the payload with an error when the channel has no refresh token', async () => {
    sm.accessSecretVersion.mockRejectedValue(Object.assign(new Error('nf'), { code: 5 }));
    const job = await makeJob();
    await approve(job, input());
    const after = (await getJob('job1'))!;
    expect(after.state).toBe('PAYLOAD');
    expect(after.error).toBe('The upload channel is not connected.');
    expect(after.payload).not.toBeNull();
    expect(sm.accessSecretVersion.mock.calls[0]![0]).toEqual({
      name: 'projects/p/secrets/yt-refresh-sandbox/versions/latest',
    });
  });

  it('ends at the payload when visitor upload quota is spent', async () => {
    connected();
    store.set(`quota/${quotaDay()}`, {
      runs: 0,
      ips: {},
      uploads: VISITOR_UPLOADS_PER_DAY,
      visitorUploads: VISITOR_UPLOADS_PER_DAY,
    });
    const job = await makeJob();
    await approve(job, input());
    const after = (await getJob('job1'))!;
    expect(after.state).toBe('PAYLOAD');
    expect(after.error).toBe("Today's upload quota is used up.");
  });

  it("still uploads Nathan's job when only the visitor share is spent", async () => {
    connected();
    store.set(`quota/${quotaDay()}`, {
      runs: 0,
      ips: {},
      uploads: VISITOR_UPLOADS_PER_DAY,
      visitorUploads: VISITOR_UPLOADS_PER_DAY,
    });
    const job = await makeJob({ owner: 'nathan', channel: 'nathan' });
    await approve(job, input());
    expect((await getJob('job1'))!.state).toBe('PUBLISHING');
    expect(store.get(`quota/${quotaDay()}`)).toMatchObject({ uploads: 5, visitorUploads: 4 });
  });

  it("ends Nathan's job at the payload once all six uploads are spent", async () => {
    connected();
    store.set(`quota/${quotaDay()}`, {
      runs: 0,
      ips: {},
      uploads: UPLOADS_PER_DAY,
      visitorUploads: 0,
    });
    const job = await makeJob({ owner: 'nathan', channel: 'nathan' });
    await approve(job, input());
    expect((await getJob('job1'))!.state).toBe('PAYLOAD');
  });

  it('moves to PUBLISHING with the final fields and maps hashtags to candidate casing', async () => {
    connected();
    const job = await makeJob({ patch: { consecutiveFailures: 2, error: 'old' } });
    await approve(job, input({ description: 'Edited.\n\n#synthwave #newmusic' }));
    const after = (await getJob('job1'))!;
    expect(after.state).toBe('PUBLISHING');
    expect(after.finalFields).toEqual({
      title: 'Title 1',
      description: 'Edited.\n\n#synthwave #newmusic',
      hashtags: ['#synthwave', '#NewMusic'],
      tags: ['synthwave', 'PeekaBoo'],
    });
    expect(after.payload).toBeNull();
    expect(after.consecutiveFailures).toBe(0);
    expect(after.error).toBeNull();
    expect(store.get(`quota/${quotaDay()}`)).toMatchObject({ uploads: 1, visitorUploads: 1 });
  });

  it('keeps visitor feedback on the job', async () => {
    const job = await makeJob({ channel: null });
    await approve(job, input({ title: 'Edited Title' }));
    const rows = feedbackRows('jobs/job1/feedback/');
    expect(rows.map((r) => [r.kind, r.field])).toEqual([
      ['EDITED', 'title'],
      ['ACCEPTED', undefined],
    ]);
    expect(rows[0]).toMatchObject({ before: 'Title 1', after: 'Edited Title', pickVersion: 1 });
    expect(feedbackRows('artists/')).toHaveLength(0);
  });

  it("writes Nathan's feedback to the artist's memory", async () => {
    connected();
    const job = await makeJob({ owner: 'nathan', channel: 'nathan', picks: 2 });
    await approve(job, input({ title: 'Title 2', pickVersion: 2 }));
    const rows = feedbackRows('artists/flr/feedback/');
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'ACCEPTED',
        pickVersion: 2,
        songTitle: 'PeekaBoo',
        jobId: 'job1',
      }),
    ]);
    expect(feedbackRows('jobs/job1/feedback/')).toHaveLength(0);
  });
});

describe('rerun', () => {
  it('requires REVIEW', async () => {
    const job = await makeJob({ state: 'PUBLISHING' });
    expect((await rejection(rerun(job))).status).toBe(409);
  });

  it('skips the latest pick, records a SKIPPED row, and returns to PICK', async () => {
    const job = await makeJob({ picks: 2, patch: { consecutiveFailures: 1, error: 'x' } });
    await rerun(job);
    expect((await listPicks('job1')).map((p) => [p.version, p.skipped])).toEqual([
      [1, false],
      [2, true],
    ]);
    const rows = feedbackRows('jobs/job1/feedback/');
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'SKIPPED',
        pickVersion: 2,
        before: 'Title 2',
        jobId: 'job1',
      }),
    ]);
    const after = (await getJob('job1'))!;
    expect(after.state).toBe('PICK');
    expect(after.consecutiveFailures).toBe(0);
    expect(after.error).toBeNull();
  });

  it("stores Nathan's skip in the artist's memory", async () => {
    const job = await makeJob({ owner: 'nathan', channel: 'nathan' });
    await rerun(job);
    expect(feedbackRows('artists/flr/feedback/')).toEqual([
      expect.objectContaining({ kind: 'SKIPPED' }),
    ]);
    expect(feedbackRows('jobs/job1/feedback/')).toHaveLength(0);
  });

  it('still returns to PICK when there is no pick to skip', async () => {
    const job = await makeJob({ picks: 0 });
    await rerun(job);
    expect((await getJob('job1'))!.state).toBe('PICK');
    expect(feedbackRows('jobs/job1/feedback/')).toHaveLength(0);
  });
});

describe('concurrent actions', () => {
  it('approves once when the same recommendation is submitted twice', async () => {
    connected();
    const job = await makeJob();
    await approve(job, input());
    const second = await rejection(approve(job, input()));
    expect(second.status).toBe(409);
    const quota = [...store.entries()].find(([k]) => k.startsWith('quota/'))![1] as {
      uploads: number;
    };
    expect(quota.uploads).toBe(1);
    expect(feedbackRows('jobs/job1/feedback/').filter((r) => r.kind === 'ACCEPTED')).toHaveLength(
      1,
    );
  });

  it('refuses a re-run once the job already left review', async () => {
    const job = await makeJob();
    await updateJob('job1', { state: 'DISCARDED' });
    expect((await rejection(rerun(job))).status).toBe(409);
    expect((await getJob('job1'))!.state).toBe('DISCARDED');
  });

  it('refuses a discard once the job moved past discardable states', async () => {
    const job = await makeJob({ state: 'REVIEW' });
    await updateJob('job1', { state: 'PUBLISHING' });
    expect((await rejection(discard(job))).status).toBe(409);
  });

  it('refuses a retry once the job is no longer failed', async () => {
    const job = await makeJob({ state: 'FAILED', patch: { failedState: 'ANALYZE' } });
    await updateJob('job1', { state: 'ANALYZE' });
    expect((await rejection(retry(job))).status).toBe(409);
  });
});

describe('discard', () => {
  it.each<JobState>(['AWAITING_UPLOAD', 'PREP', 'ANALYZE', 'PICK', 'REVIEW', 'FAILED', 'PAYLOAD'])(
    'discards a %s job',
    async (state) => {
      const job = await makeJob({ state });
      await discard(job);
      expect((await getJob('job1'))!.state).toBe('DISCARDED');
    },
  );

  it.each<JobState>(['PUBLISHING', 'CLAIMED_COMPLETE', 'VERIFIED', 'DISCARDED'])(
    'refuses a %s job with 409',
    async (state) => {
      const job = await makeJob({ state });
      expect((await rejection(discard(job))).status).toBe(409);
      expect((await getJob('job1'))!.state).toBe(state);
    },
  );

  it('learns nothing from a discard', async () => {
    const job = await makeJob();
    await discard(job);
    expect(feedbackRows('jobs/job1/feedback/')).toHaveLength(0);
    expect(feedbackRows('artists/')).toHaveLength(0);
  });
});

describe('retry', () => {
  it('restores the failed state and clears counters', async () => {
    const job = await makeJob({
      state: 'FAILED',
      patch: { failedState: 'ANALYZE', consecutiveFailures: 2, verifyAttempts: 3, error: 'boom' },
    });
    await retry(job);
    const after = (await getJob('job1'))!;
    expect(after).toMatchObject({
      state: 'ANALYZE',
      failedState: null,
      consecutiveFailures: 0,
      verifyAttempts: 0,
      error: null,
    });
  });

  it('starts a fresh upload session when the upload failed', async () => {
    const job = await makeJob({
      state: 'FAILED',
      patch: {
        failedState: 'PUBLISHING',
        upload: { sessionUri: 'https://upload.example/dead', total: 10 },
        uploadProgress: { sent: 5, total: 10 },
      },
    });
    await retry(job);
    expect(await getJob('job1')).toMatchObject({
      state: 'PUBLISHING',
      upload: null,
      uploadProgress: null,
    });
  });

  it('falls back to PREP when no failed state was recorded', async () => {
    const job = await makeJob({ state: 'FAILED', patch: { failedState: null } });
    await retry(job);
    expect((await getJob('job1'))!.state).toBe('PREP');
  });

  it('refuses a job that has not failed', async () => {
    const job = await makeJob({ state: 'REVIEW' });
    const error = await rejection(retry(job));
    expect(error.status).toBe(409);
    expect(error.message).toBe('Not allowed while the job is REVIEW.');
  });
});

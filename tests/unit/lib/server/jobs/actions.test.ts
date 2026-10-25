// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { approve, discard, makeShort, recut, rerun, retry } from '#lib/server/jobs/actions.js';
import { STALE_ANALYSIS } from '#lib/server/pipeline/short.js';
import { ActionError } from '#lib/server/core/errors.js';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { artistMemory, connections, jobAudience, jobs, users } from '#lib/server/core/schema.js';
import { createJob, getJob, listPicks, type JobDoc } from '#lib/server/jobs/jobs.js';
import { jobSet, type JobPatch } from '#lib/server/jobs/rows.js';
import { saveAudience } from '#lib/server/jobs/audience.js';
import type { Hook, JobState, Pick, Short } from '#lib/types.js';
import { seed, truncate } from '../../../../helpers/db';
import { CHANNEL_A, USER_A, USER_B, USERS } from '../../../../helpers/pipeline';

/** Objects the bucket's lifecycle already deleted; every other object exists. */
const deleted = vi.hoisted(() => new Set<string>());

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return {
        file: (object: string) => ({
          exists: async () => [!deleted.has(object)],
          getMetadata: async () => [{ size: '10', contentType: 'video/mp4' }],
        }),
      };
    }
  },
}));

const SYNTHWAVE_TAG = '#synthwave';
const RETROWAVE = '#retrowave';
const DESCRIPTION = 'A bright synth track.\n\n#synthwave #retrowave';
const EDITED_TITLE = 'Edited Title';
const CHANNEL_B = 'UCb';
const RECONNECT = 'Reconnect YouTube to approve.';

const candidates = [SYNTHWAVE_TAG, RETROWAVE, '#NewMusic'];

const pick = (version: number, title = `Title ${version}`): Pick => ({
  version,
  title,
  description: DESCRIPTION,
  hashtags: [SYNTHWAVE_TAG, RETROWAVE],
  tags: ['synthwave', 'outrun'],
  flags: [],
  brandCheck: '',
  why: { title: '', description: '', tags: '' },
  bandcamp: { about: 'Bandcamp about.', credits: 'Written by Nathan.' },
  modelMs: 1,
});

const patchJob = (fields: JobPatch) =>
  db().transaction(async (tx) => {
    await tx.update(jobs).set(jobSet(fields)).where(eq(jobs.id, 'job1'));
    if (fields.audience) await saveAudience(tx, 'job1', fields.audience);
  });

/** B's job by default: no artist link, so its feedback stays on the job. */
async function makeJob(
  opts: {
    owner?: typeof USER_A | typeof USER_B;
    state?: JobState;
    picks?: number;
    patch?: Partial<JobDoc>;
  } = {},
): Promise<JobDoc> {
  const owner = opts.owner ?? USER_B;
  const id = 'job1';
  // A second call replaces the job, like the tests that build two variants in a row expect.
  await db().delete(jobs).where(eq(jobs.id, id));
  await createJob(
    {
      ownerUid: owner.uid,
      artistId: owner.artistId,
      songTitle: 'PeekaBoo',
      notes: '',
      filename: 'p.mp4',
      contentType: 'video/mp4',
      object: 'uploads/p.mp4',
      trace: null,
    },
    id,
  );
  const picks = opts.picks ?? 1;
  await db()
    .update(jobs)
    .set({
      picks: Array.from({ length: picks }, (_, i) => ({ ...pick(i + 1), skipped: false })),
    })
    .where(eq(jobs.id, id));
  await patchJob({
    state: opts.state ?? 'REVIEW',
    hashtagCandidates: candidates,
    pickVersion: picks > 0 ? picks : null,
    audience: {
      retrievedAt: Date.now(),
      query: 'synthwave music video',
      candidateLists: [
        {
          videoId: 'peer',
          title: 'Peer release',
          hashtags: candidates,
          tags: ['synthwave', 'outrun', '42'].map((tag) => ({ tag })),
        },
      ],
      top: [],
    },
    ...opts.patch,
  });
  return (await getJob(id))!;
}

type Input = Parameters<typeof approve>[1];

/** An approval of B's job, as the page sends it: B's connected channel was shown. */
const input = (over: Partial<Input> = {}): Input => ({
  title: 'Title 1',
  description: DESCRIPTION,
  tags: ['synthwave', 'outrun'],
  pickVersion: 1,
  channelId: CHANNEL_B,
  ...over,
});

/** An approval of A's job, which shows A's channel. */
const inputA = (over: Partial<Input> = {}) => input({ channelId: CHANNEL_A, ...over });

const jobRows = async () =>
  (await db().select({ feedback: jobs.feedback }).from(jobs)).flatMap(
    (r) => r.feedback as Record<string, unknown>[],
  );
const artistRows = async () =>
  (
    await db()
      .select({ data: artistMemory.data })
      .from(artistMemory)
      .where(eq(artistMemory.kind, 'feedback'))
      .orderBy(artistMemory.id)
  ).map((r) => r.data as Record<string, unknown>);

const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ActionError);
  return error as ActionError;
};

const unlinkA = () => db().update(users).set({ artistId: null }).where(eq(users.uid, USER_A.uid));
const ARTIST = 'Flies Like Robots';

const setBStatus = (status: 'connected' | 'missing_scopes' | 'no_channel' | 'revoked') =>
  db()
    .update(connections)
    .set({ status, tokenCiphertext: status === 'connected' ? 'c2VhbGVk' : null })
    .where(eq(connections.uid, USER_B.uid));

beforeEach(async () => {
  resetClients();
  deleted.clear();
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'b');
  vi.clearAllMocks();
  await truncate();
  await seed(USERS);
  await seed({
    connections: [
      {
        uid: USER_B.uid,
        status: 'connected',
        channelId: CHANNEL_B,
        channelTitle: 'B Sides',
        scopes: [],
        tokenCiphertext: 'c2VhbGVk',
        updatedAt: new Date(0),
      },
    ],
  });
});

describe('approve', () => {
  it('accepts tags and hashtags selected across separate source lists', async () => {
    const job = await makeJob({
      patch: {
        audience: {
          retrievedAt: Date.now(),
          query: 'synthwave music video',
          candidateLists: [
            {
              videoId: 'one',
              title: 'One',
              hashtags: [SYNTHWAVE_TAG],
              tags: [{ tag: 'synthwave' }],
            },
            { videoId: 'two', title: 'Two', hashtags: [RETROWAVE], tags: [{ tag: 'outrun' }] },
          ],
          top: [],
        },
      },
    });
    await approve(job, input());
    expect((await getJob('job1'))!.finalFields).toMatchObject({
      hashtags: [SYNTHWAVE_TAG, RETROWAVE],
      tags: ['synthwave', 'outrun'],
    });
  });

  it('requires REVIEW', async () => {
    const job = await makeJob({ state: 'ANALYZE' });
    const error = await rejection(approve(job, input()));
    expect(error.status).toBe(409);
    expect(error.message).toBe('Not allowed while the job is ANALYZE.');
  });

  it('refuses an approval with no recommendation on the job', async () => {
    const job = await makeJob({ picks: 0 });
    const error = await rejection(approve(job, input()));
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/newer recommendation/);
  });

  it('refuses an approval that names an older pick', async () => {
    const job = await makeJob({ picks: 2 });
    const error = await rejection(approve(job, input({ pickVersion: 1 })));
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/newer recommendation/);
    expect((await getJob('job1'))!.state).toBe('REVIEW');
    expect(await jobRows()).toHaveLength(0);
  });

  it('refuses an approval with no pick version', async () => {
    const job = await makeJob();
    expect((await rejection(approve(job, input({ pickVersion: Number.NaN })))).status).toBe(400);
  });

  it('refuses when the job names a pick version that was never stored', async () => {
    const job = await makeJob({ patch: { pickVersion: 7 } });
    expect((await rejection(approve(job, input({ pickVersion: 7 })))).status).toBe(409);
  });

  it('rejects edited tags that contain the song title, as whole words', async () => {
    const job = await makeJob();
    const error = await approve(job, input({ tags: ['synthwave', 'peekaboo live'] })).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      status: 422,
      fields: { tags: "Tags can't contain the song title: peekaboo live" },
    });
    expect((await getJob('job1'))!.state).toBe('REVIEW');
  });

  it("rejects edited tags outside the job's tag list", async () => {
    const job = await makeJob();
    const error = await approve(job, input({ tags: ['synthwave', 'study music'] })).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      status: 422,
      fields: { tags: "Not in this job's tag list: study music" },
    });
  });

  it("accepts the artist name and candidate tags in any case on Nathan's job", async () => {
    const job = await makeJob({ owner: USER_A });
    await approve(job, inputA({ tags: ['flies like robots', 'SYNTHWAVE'] }));
    expect((await getJob('job1'))!.state).toBe('PUBLISHING');
  });

  it('rejects the artist name as a tag on an unlinked job', async () => {
    const job = await makeJob();
    const error = await rejection(approve(job, input({ tags: ['synthwave', ARTIST] })));
    expect(error.fields).toEqual({ tags: `Not in this job's tag list: ${ARTIST}` });
  });

  it('rejects the artist name even when the genre search returned it, on an unlinked job', async () => {
    const job = await makeJob({
      patch: {
        audience: {
          retrievedAt: Date.now(),
          query: 'q',
          candidateLists: [
            {
              videoId: 'peer',
              title: 'Peer release',
              hashtags: candidates,
              tags: [{ tag: ARTIST }],
            },
          ],
          top: [],
        },
      },
    });
    expect((await rejection(approve(job, input({ tags: [ARTIST] })))).status).toBe(422);
  });

  it("rejects the artist name once Nathan's job owner is unlinked", async () => {
    const job = await makeJob({ owner: USER_A });
    await unlinkA();
    const error = await rejection(approve(job, inputA({ tags: [ARTIST] })));
    expect(error.status).toBe(422);
    expect((await getJob('job1'))!.state).toBe('REVIEW');
  });

  it('reports a YouTube limit before the tag list', async () => {
    const job = await makeJob();
    const error = await approve(job, input({ tags: [SYNTHWAVE_TAG] })).catch((e: unknown) => e);
    expect(error).toMatchObject({
      fields: { tags: 'Tags are plain terms; hashtags belong in the description.' },
    });
  });

  it('rejects a stray hashtag with 422 field errors and records nothing', async () => {
    const job = await makeJob();
    const error = await rejection(approve(job, input({ description: 'Out now #invented' })));
    expect(error.status).toBe(422);
    expect(error.fields).toEqual({ description: "Not in this job's hashtag list: #invented" });
    expect(await jobRows()).toHaveLength(0);
    expect((await getJob('job1'))!.state).toBe('REVIEW');
  });

  it('rejects any hashtag when the job has no candidates', async () => {
    const job = await makeJob({
      patch: {
        audience: { retrievedAt: Date.now(), query: 'q', candidateLists: [], top: [] },
      },
    });
    const error = await rejection(approve(job, input()));
    expect(error.status).toBe(422);
    expect(error.fields?.description).toContain(SYNTHWAVE_TAG);
  });

  it('approves the saved draft after its research expires without retaining the candidate pool', async () => {
    await makeJob();
    await db()
      .update(jobAudience)
      .set({ retrievedAt: sql`now() - interval '31 days'` });
    const job = (await getJob('job1'))!;
    expect(job.audience).toBeNull();

    await approve(job, input());

    expect((await getJob('job1'))!.finalFields).toMatchObject({
      description: DESCRIPTION,
      tags: ['synthwave', 'outrun'],
    });
  });

  it('rejects a tag from expired research that was never selected in the saved draft', async () => {
    await makeJob();
    await db()
      .update(jobAudience)
      .set({ retrievedAt: sql`now() - interval '31 days'` });

    const error = await rejection(approve((await getJob('job1'))!, input({ tags: ['42'] })));

    expect(error.status).toBe(422);
    expect(error.fields?.tags).toContain('Not in this job');
    expect((await getJob('job1'))!.state).toBe('REVIEW');
  });

  it('reports title and tags errors together', async () => {
    const job = await makeJob();
    const error = await rejection(
      approve(job, input({ title: ' ', tags: Array.from({ length: 100 }, () => 'long tag') })),
    );
    expect(Object.keys(error.fields!).sort((a, b) => a.localeCompare(b))).toEqual([
      'tags',
      'title',
    ]);
  });
});

describe('approve: where the upload goes', () => {
  it.each(['missing_scopes', 'no_channel', 'revoked'] as const)(
    'refuses with 409 and changes nothing while YouTube is %s',
    async (status) => {
      await setBStatus(status);
      const job = await makeJob();
      const error = await rejection(approve(job, input()));
      expect([error.status, error.message]).toEqual([409, RECONNECT]);
      expect(await getJob('job1')).toMatchObject({ state: 'REVIEW', destination: null });
      expect(await jobRows()).toHaveLength(0);
    },
  );

  it('refuses with 409 when the owner never connected YouTube', async () => {
    await db().delete(connections).where(eq(connections.uid, USER_B.uid));
    const job = await makeJob();
    expect((await rejection(approve(job, input()))).message).toBe(RECONNECT);
  });

  it('refuses with 409 and changes nothing when the connected channel changed since the page loaded', async () => {
    const job = await makeJob();
    await db()
      .update(connections)
      .set({ channelId: 'UCnew', channelTitle: 'New' })
      .where(eq(connections.uid, USER_B.uid));
    const error = await rejection(approve(job, input()));
    expect([error.status, error.message]).toEqual([
      409,
      'Your YouTube channel changed. Reload to approve.',
    ]);
    expect(await getJob('job1')).toMatchObject({ state: 'REVIEW', destination: null });
    expect(await jobRows()).toHaveLength(0);
  });

  it('refuses an approval that names no channel', async () => {
    const job = await makeJob();
    const error = await rejection(approve(job, input({ channelId: '' })));
    expect([error.status, error.message]).toEqual([400, 'Name the channel being approved to.']);
  });

  it('never re-pins a job whose upload already started, rolling back its feedback', async () => {
    const job = await makeJob();
    await db()
      .update(jobs)
      .set({ uploadStartedAt: new Date(5) })
      .where(eq(jobs.id, 'job1'));
    const error = await rejection(approve(job, input({ title: EDITED_TITLE })));
    expect([error.status, error.message]).toEqual([409, 'This job already started uploading.']);
    expect(await getJob('job1')).toMatchObject({ state: 'REVIEW', destination: null });
    expect(await jobRows()).toHaveLength(0);
  });

  it("pins the owner's connected channel, never another user's", async () => {
    const job = await makeJob();
    await approve(job, input());
    expect((await getJob('job1'))!.destination).toEqual({
      channelId: CHANNEL_B,
      channelTitle: 'B Sides',
    });
  });

  it('moves to PUBLISHING with the final fields and maps hashtags to candidate casing', async () => {
    const job = await makeJob({ patch: { consecutiveFailures: 2, error: 'old' } });
    await approve(
      job,
      input({ title: '  Title 1  ', description: 'Edited.\n\n#synthwave #newmusic' }),
    );
    const after = (await getJob('job1'))!;
    expect(after.state).toBe('PUBLISHING');
    expect(after.finalFields).toEqual({
      title: 'Title 1',
      description: 'Edited.\n\n#synthwave #newmusic',
      hashtags: [SYNTHWAVE_TAG, '#NewMusic'],
      tags: ['synthwave', 'outrun'],
    });
    expect(after.consecutiveFailures).toBe(0);
    expect(after.error).toBeNull();
  });

  it('keeps feedback on a job with no artist link on the job', async () => {
    const job = await makeJob();
    await approve(job, input({ title: EDITED_TITLE }));
    const rows = await jobRows();
    expect(rows.map((r) => [r.kind, r.field])).toEqual([
      ['EDITED', 'title'],
      ['ACCEPTED', undefined],
    ]);
    expect(rows[0]).toMatchObject({ before: 'Title 1', after: EDITED_TITLE, pickVersion: 1 });
    expect(await artistRows()).toHaveLength(0);
  });

  it("writes feedback on Nathan's job to the artist's memory", async () => {
    const job = await makeJob({ owner: USER_A, picks: 2 });
    await approve(job, inputA({ title: 'Title 2', pickVersion: 2 }));
    expect(await artistRows()).toEqual([
      expect.objectContaining({
        kind: 'ACCEPTED',
        pickVersion: 2,
        songTitle: 'PeekaBoo',
        jobId: 'job1',
      }),
    ]);
    expect(await jobRows()).toHaveLength(0);
    expect((await getJob('job1'))!.destination?.channelId).toBe(CHANNEL_A);
  });
});

describe('approve: artist memory follows the current link', () => {
  it("keeps feedback on the job once Nathan's job owner is unlinked", async () => {
    const job = await makeJob({ owner: USER_A });
    await unlinkA();
    await approve(job, inputA({ title: EDITED_TITLE }));
    expect(await artistRows()).toHaveLength(0);
    expect((await jobRows()).map((r) => r.kind)).toEqual(['EDITED', 'ACCEPTED']);
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
    expect(await jobRows()).toEqual([
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
    const job = await makeJob({ owner: USER_A });
    await rerun(job);
    expect(await artistRows()).toEqual([expect.objectContaining({ kind: 'SKIPPED' })]);
    expect(await jobRows()).toHaveLength(0);
  });

  it("keeps the skip on the job once Nathan's job owner is unlinked", async () => {
    const job = await makeJob({ owner: USER_A });
    await unlinkA();
    await rerun(job);
    expect(await artistRows()).toHaveLength(0);
    expect(await jobRows()).toEqual([expect.objectContaining({ kind: 'SKIPPED' })]);
  });

  it('still returns to PICK when there is no pick to skip', async () => {
    const job = await makeJob({ picks: 0 });
    await rerun(job);
    expect((await getJob('job1'))!.state).toBe('PICK');
    expect(await jobRows()).toHaveLength(0);
  });
});

describe('concurrent actions', () => {
  it('approves once when the same recommendation is submitted twice', async () => {
    const job = await makeJob();
    await approve(job, input());
    const second = await rejection(approve(job, input()));
    expect(second.status).toBe(409);
    expect((await jobRows()).filter((r) => r.kind === 'ACCEPTED')).toHaveLength(1);
  });

  it('approves once when two submits race', async () => {
    const job = await makeJob();
    const results = await Promise.allSettled([approve(job, input()), approve(job, input())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await jobRows()).filter((r) => r.kind === 'ACCEPTED')).toHaveLength(1);
  });

  it('refuses a re-run once the job already left review', async () => {
    const job = await makeJob();
    await patchJob({ state: 'DISCARDED' });
    expect((await rejection(rerun(job))).status).toBe(409);
    expect((await getJob('job1'))!.state).toBe('DISCARDED');
  });

  it('refuses a discard once the job moved past discardable states', async () => {
    const job = await makeJob({ state: 'REVIEW' });
    await patchJob({ state: 'VERIFIED' });
    expect((await rejection(discard(job))).status).toBe(409);
  });

  it('refuses a retry once the job is no longer failed', async () => {
    const job = await makeJob({ state: 'FAILED', patch: { failedState: 'ANALYZE' } });
    await patchJob({ state: 'ANALYZE' });
    expect((await rejection(retry(job))).status).toBe(409);
  });
});

describe('discard', () => {
  it.each<JobState>([
    'AWAITING_UPLOAD',
    'PREP',
    'ANALYZE',
    'PICK',
    'REVIEW',
    'FAILED',
    'PUBLISHING',
    'CLAIMED_COMPLETE',
  ])('discards a %s job', async (state) => {
    const job = await makeJob({ state });
    await discard(job);
    expect((await getJob('job1'))!.state).toBe('DISCARDED');
  });

  it.each<JobState>(['VERIFIED', 'DISCARDED'])('refuses a %s job with 409', async (state) => {
    const job = await makeJob({ state });
    expect((await rejection(discard(job))).status).toBe(409);
    expect((await getJob('job1'))!.state).toBe(state);
  });

  it('keeps the video ID YouTube already returned', async () => {
    const job = await makeJob({ state: 'CLAIMED_COMPLETE', patch: { videoId: 'vid1' } });
    await discard(job);
    expect(await getJob('job1')).toMatchObject({ state: 'DISCARDED', videoId: 'vid1' });
  });

  it('learns nothing from a discard', async () => {
    const job = await makeJob();
    await discard(job);
    expect(await jobRows()).toHaveLength(0);
    expect(await artistRows()).toHaveLength(0);
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

  it('keeps the upload session, so the next step asks YouTube where it stands', async () => {
    const upload = { sessionUri: 'https://upload.example/s', total: 10 };
    const uploadProgress = { sent: 5, total: 10 };
    const job = await makeJob({
      state: 'FAILED',
      patch: { failedState: 'PUBLISHING', upload, uploadProgress },
    });
    await retry(job);
    expect(await getJob('job1')).toMatchObject({ state: 'PUBLISHING', upload, uploadProgress });
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

describe('makeShort', () => {
  const PROBE = { durationSec: 180, width: 1920, height: 1080, hasAudio: true };

  const approved = (patch: Partial<JobDoc> = {}, picks?: number) =>
    makeJob({ state: 'VERIFIED', picks, patch: { probe: PROBE, chunkCount: 3, ...patch } });

  it('starts a Short from the approved pick', async () => {
    const id = await makeShort(await approved({}, 2));
    const short = (await getJob(id))!;
    expect(short).toMatchObject({
      state: 'HOOK',
      parentId: 'job1',
      ownerUid: USER_B.uid,
      artistId: null,
      destination: null,
    });
    expect((await listPicks(id)).map((p) => [p.version, p.title])).toEqual([[1, 'Title 2']]);
    expect((await getJob('job1'))!.shortId).toBe(id);
  });

  it("starts from the artist's approved fields once the video was approved", async () => {
    const final = {
      title: 'Edited',
      description: 'Mine. #synthwave',
      hashtags: [SYNTHWAVE_TAG],
      tags: ['synthwave'],
    };
    const job = await makeJob({
      state: 'VERIFIED',
      patch: { probe: PROBE, chunkCount: 3, finalFields: final },
    });
    const id = await makeShort(job);
    const [stored] = await listPicks(id);
    expect(stored).toMatchObject({ ...final, version: 1, brandCheck: '' });
  });

  it("copies the owner and artist link from Nathan's video, never its destination", async () => {
    const job = await makeJob({
      owner: USER_A,
      state: 'VERIFIED',
      patch: {
        probe: PROBE,
        chunkCount: 3,
        destination: { channelId: CHANNEL_A, channelTitle: 'FLR' },
      },
    });
    const short = (await getJob(await makeShort(job)))!;
    expect(short).toMatchObject({ ownerUid: USER_A.uid, artistId: 'flr', destination: null });
  });

  it('refuses once storage has deleted the video, starting no Short', async () => {
    const job = await makeJob({ state: 'VERIFIED', patch: { probe: PROBE, chunkCount: 3 } });
    deleted.add(job.object);
    const error = await rejection(makeShort(job));
    expect([error.status, error.message]).toEqual([
      409,
      'This video is gone from storage. Upload it again to make a Short.',
    ]);
    expect((await getJob('job1'))!.shortId).toBeNull();
    expect(await db().select({ id: jobs.id }).from(jobs)).toEqual([{ id: 'job1' }]);
  });

  it('returns the live Short instead of starting another', async () => {
    const job = await approved();
    const first = await makeShort(job);
    expect(await makeShort((await getJob('job1'))!)).toBe(first);
  });

  it('refuses a video under 15 seconds and accepts one of exactly 15', async () => {
    const short = await approved({ probe: { ...PROBE, durationSec: 14.9 }, chunkCount: 1 });
    const error = await rejection(makeShort(short));
    expect([error.status, error.message]).toEqual([
      409,
      'A Short needs a video of at least 15 seconds.',
    ]);
    expect((await getJob('job1'))!.shortId).toBeNull();
    await patchJob({ probe: { ...PROBE, durationSec: 15 } });
    expect(await makeShort((await getJob('job1'))!)).toEqual(expect.any(String));
  });

  it('refuses a video analyzed at another window length, starting no Short', async () => {
    const job = await approved({ chunkCount: 6 });
    const error = await rejection(makeShort(job));
    expect([error.status, error.message]).toEqual([409, STALE_ANALYSIS]);
    expect((await getJob('job1'))!.shortId).toBeNull();
  });

  it.each(['ANALYZE', 'REVIEW'] as const)(
    'refuses a video not yet approved (%s)',
    async (state) => {
      const job = await makeJob({ state, patch: { probe: PROBE, chunkCount: 3 } });
      const error = await rejection(makeShort(job));
      expect([error.status, error.message]).toEqual([
        409,
        `Not allowed while the job is ${state}.`,
      ]);
    },
  );

  it('refuses a Short of a Short', async () => {
    const job = await approved();
    const short = (await getJob(await makeShort(job)))!;
    const error = await rejection(makeShort({ ...short, state: 'REVIEW' }));
    expect([error.status, error.message]).toEqual([409, "A Short can't be cut from a Short."]);
  });

  it('refuses a video with no known length', async () => {
    const job = await makeJob({ state: 'VERIFIED' });
    expect((await rejection(makeShort(job))).message).toBe("This video's length is unknown.");
    const zero = await approved({ probe: { ...PROBE, durationSec: 0 } });
    expect((await rejection(makeShort(zero))).status).toBe(409);
  });

  it('refuses a video with no recommendation', async () => {
    const job = await approved({}, 0);
    expect((await rejection(makeShort(job))).message).toBe(
      'This video has no recommendation to start from.',
    );
  });

  it('refuses when the video moved on before the transaction', async () => {
    const job = await approved();
    await patchJob({ state: 'DISCARDED' });
    expect((await rejection(makeShort(job))).message).toBe(
      'The video moved on before the Short could start.',
    );
  });
});

const HOOK: Hook = { window: 2, startSec: 70, lengthSec: 30, reason: 'The chorus lands.' };
const SHORT: Short = {
  sourceDurationSec: 180,
  reframe: 'blur',
  hook: HOOK,
  skipped: [],
  renders: 1,
  modelMs: 900,
};

async function shortJob(
  opts: { state?: JobState; short?: Partial<Short>; owner?: typeof USER_A } = {},
) {
  return makeJob({
    state: opts.state ?? 'REVIEW',
    owner: opts.owner,
    patch: { short: { ...SHORT, ...opts.short }, sourceObject: 'uploads/p1' },
  });
}

const PROBE_180 = { durationSec: 180, width: 1920, height: 1080, hasAudio: true };

describe('recut', () => {
  it('re-renders with the new framing and keeps the reason when the cut stays put', async () => {
    const job = await shortJob();
    await recut(job, { startSec: 70, lengthSec: 30, reframe: 'crop' });
    const after = (await getJob('job1'))!;
    expect(after.state).toBe('RENDER');
    expect(after.short).toEqual({ ...SHORT, reframe: 'crop' });
  });

  it("moves the cut to the artist's start and length and clears the model's reason", async () => {
    const job = await shortJob();
    await recut(job, { startSec: 81.24, lengthSec: 22.06, reframe: 'blur' });
    expect((await getJob('job1'))!.short!.hook).toEqual({
      ...HOOK,
      startSec: 81.2,
      lengthSec: 22.1,
      reason: '',
    });
  });

  it('re-cuts an existing cut after its video went stale under older windows', async () => {
    const id = await makeShort(
      await makeJob({ state: 'VERIFIED', patch: { probe: PROBE_180, chunkCount: 3 } }),
    );
    await patchJob({ chunkCount: 6 });
    await db()
      .update(jobs)
      .set(jobSet({ state: 'REVIEW', short: SHORT }))
      .where(eq(jobs.id, id));
    await recut((await getJob(id))!, { startSec: 90, lengthSec: 30, reframe: 'blur' });
    expect((await getJob(id))!).toMatchObject({ state: 'RENDER', error: null });
  });

  it('accepts a cut ending exactly at the end of the source', async () => {
    const job = await shortJob();
    await recut(job, { startSec: 120, lengthSec: 60, reframe: 'blur' });
    expect((await getJob('job1'))!.short!.hook).toMatchObject({ startSec: 120, lengthSec: 60 });
  });

  it('rejects an unknown framing', async () => {
    const job = await shortJob();
    const error = await rejection(recut(job, { startSec: 70, lengthSec: 30, reframe: 'stretch' }));
    expect([error.status, error.message]).toEqual([400, 'Pick blur fill or center crop.']);
  });

  it('rejects a length outside 15–60 s, and a start past the end', async () => {
    const job = await shortJob();
    expect(
      (await rejection(recut(job, { startSec: 0, lengthSec: 10, reframe: 'blur' }))).message,
    ).toBe('Length must be 15 to 60 seconds.');
    expect(
      (await rejection(recut(job, { startSec: 170, lengthSec: 30, reframe: 'blur' }))).message,
    ).toBe('Start must be 0 to 150 seconds for that length.');
    expect(
      (await rejection(recut(job, { startSec: Number.NaN, lengthSec: 30, reframe: 'blur' })))
        .status,
    ).toBe(400);
    expect((await getJob('job1'))!.state).toBe('REVIEW');
  });

  it('refuses a video job, and a Short with no cut yet', async () => {
    const video = await makeJob();
    expect(
      (await rejection(recut(video, { startSec: 0, lengthSec: 30, reframe: 'blur' }))).message,
    ).toBe('Only a cut Short can be re-cut.');
    const uncut = await shortJob({ state: 'HOOK', short: { hook: null } });
    expect(
      (await rejection(recut(uncut, { startSec: 0, lengthSec: 30, reframe: 'blur' }))).status,
    ).toBe(409);
  });

  it('refuses outside REVIEW', async () => {
    const job = await shortJob({ state: 'PUBLISHING' });
    const error = await rejection(recut(job, { startSec: 70, lengthSec: 30, reframe: 'blur' }));
    expect(error.message).toBe('Not allowed while the job is PUBLISHING.');
  });

  it('refuses when the Short moved on before the transition', async () => {
    const job = await shortJob();
    await patchJob({ state: 'DISCARDED' });
    const error = await rejection(recut(job, { startSec: 70, lengthSec: 30, reframe: 'blur' }));
    expect([error.status, error.message]).toEqual([409, 'This Short was already handled.']);
  });
});

describe('rerun on a Short', () => {
  it('re-picks the hook away from the current one and keeps the metadata', async () => {
    const job = await shortJob({ short: { skipped: [{ window: 0, lengthSec: 20 }] } });
    await rerun(job);
    const after = (await getJob('job1'))!;
    expect(after.state).toBe('HOOK');
    expect(after.short).toEqual({
      ...SHORT,
      hook: null,
      skipped: [
        { window: 0, lengthSec: 20 },
        { window: 2, lengthSec: 30 },
      ],
    });
    expect((await listPicks('job1')).map((p) => p.skipped)).toEqual([false]);
    expect(await jobRows()).toHaveLength(0);
    expect(await artistRows()).toHaveLength(0);
  });

  it('re-picks without adding a skip when no hook was set', async () => {
    const job = await shortJob({ short: { hook: null } });
    await rerun(job);
    expect((await getJob('job1'))!.short!.skipped).toEqual([]);
  });

  it('refuses when the Short moved on', async () => {
    const job = await shortJob();
    await patchJob({ state: 'RENDER' });
    expect((await rejection(rerun(job))).message).toBe('This Short was already handled.');
  });
});

describe('approve on a Short', () => {
  it('uploads through the same flow and does not count the acceptance twice', async () => {
    const job = await shortJob({ owner: USER_A });
    await approve(job, inputA());
    const after = (await getJob('job1'))!;
    expect(after.state).toBe('PUBLISHING');
    expect(after.finalFields?.title).toBe('Title 1');
    expect(after.destination?.channelId).toBe(CHANNEL_A);
    expect(await artistRows()).toHaveLength(0);
    expect(await jobRows()).toHaveLength(0);
  });

  it("learns Nathan's edits to the Short's metadata", async () => {
    const job = await shortJob({ owner: USER_A });
    await approve(job, inputA({ title: 'Shorter title' }));
    expect(await artistRows()).toEqual([
      expect.objectContaining({
        kind: 'EDITED',
        field: 'title',
        before: 'Title 1',
        after: 'Shorter title',
        jobId: 'job1',
      }),
    ]);
  });

  it('holds the Short to the same hashtag and tag rules', async () => {
    const job = await shortJob();
    const error = await rejection(approve(job, input({ tags: ['study music'] })));
    expect(error.status).toBe(422);
  });
});

describe('discard on a Short', () => {
  it.each(['HOOK', 'RENDER', 'REVIEW'] as JobState[])('ends a Short in %s', async (state) => {
    const job = await shortJob({ state });
    await discard(job);
    expect((await getJob('job1'))!.state).toBe('DISCARDED');
  });
});

describe('retry on a Short', () => {
  it.each(['HOOK', 'RENDER'] as JobState[])(
    'resumes at the failed %s step',
    async (failedState) => {
      const job = await shortJob({ state: 'FAILED' });
      await patchJob({ failedState });
      await retry({ ...job, failedState });
      expect((await getJob('job1'))!.state).toBe(failedState);
    },
  );
});

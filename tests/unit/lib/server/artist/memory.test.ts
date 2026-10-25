// @vitest-environment node
import { and, asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { artistMemory, jobs, users } from '#lib/server/core/schema.js';
import {
  approvalFeedback,
  artistJob,
  listFacts,
  memoryOf,
  recentFeedback,
  writeFeedback,
  recordPublish,
  type Fact,
  type Feedback,
} from '#lib/server/artist/memory.js';
import type { PickFields } from '#lib/types.js';
import { seed, truncate } from '../../../../helpers/db';
import {
  A_JOB,
  ARTIST_A,
  ARTIST_C,
  C_JOB,
  seedJob,
  USER_A,
  USER_B,
  USER_C,
  USERS,
} from '../../../../helpers/pipeline';

const OFFICIAL_TITLE = 'PeekaBoo (Official Video)';
const RICHMOND: Fact = { key: 'home', value: 'Richmond', kind: 'FACT', public: true };
const PRIVATE: Fact = { key: 'mr-kill', value: 'x', kind: 'INFERENCE', public: false };
const NAME_A: Fact = { key: 'artist-name', value: ARTIST_A.name, kind: 'FACT', public: true };

const recordFeedback = (
  entries: Parameters<typeof writeFeedback>[1],
  job: Parameters<typeof writeFeedback>[2],
) => db().transaction(async (tx) => writeFeedback(tx, entries, job));

/** The same stored job, as seen on each artist and unlinked. */
const NATHANS = { id: 'job1', ...A_JOB };
const CS = { id: 'job1', ...C_JOB };
const UNLINKED = { id: 'job1', ownerUid: USER_B.uid, artistId: null };
const unlinkA = () => db().update(users).set({ artistId: null }).where(eq(users.uid, USER_A.uid));

const entry = (at: number, kind: Feedback['kind'] = 'ACCEPTED'): Feedback => ({
  kind,
  at,
  jobId: 'job1',
  songTitle: 'PeekaBoo',
  pickVersion: 1,
});

const artistRows = () =>
  db()
    .select()
    .from(artistMemory)
    .where(eq(artistMemory.kind, 'feedback'))
    .orderBy(asc(artistMemory.id));
/** Every job's feedback entries, tagged with the job that holds them. */
const jobRows = async () =>
  (await db().select({ jobId: jobs.id, feedback: jobs.feedback }).from(jobs)).flatMap(
    ({ jobId, feedback }) => (feedback as Feedback[]).map((data) => ({ jobId, data })),
  );
const fact = (key: string) => and(memoryOf('flr', 'fact'), eq(artistMemory.key, key));

beforeEach(async () => {
  await truncate();
  await seed(USERS);
  await seedJob({ id: 'job1' });
});

describe('artistJob', () => {
  it('is true only when the job and its owner are both linked to the same profile', async () => {
    expect(await artistJob(A_JOB)).toBe(true);
    expect(await artistJob(C_JOB)).toBe(true);
  });

  it('is false for a job created without the link', async () => {
    expect(await artistJob({ ownerUid: USER_A.uid, artistId: null })).toBe(false);
  });

  it("is false once the owner's link is removed, for jobs made while linked", async () => {
    await unlinkA();
    expect(await artistJob(A_JOB)).toBe(false);
  });

  it("is false when the job names a profile other than the owner's", async () => {
    expect(await artistJob({ ownerUid: USER_B.uid, artistId: 'flr' })).toBe(false);
    expect(await artistJob({ ownerUid: USER_C.uid, artistId: 'flr' })).toBe(false);
  });

  it('is false for an owner that no longer exists', async () => {
    expect(await artistJob({ ownerUid: 'ghost', artistId: 'flr' })).toBe(false);
  });

  it("reads the owner's link inside the caller's transaction", async () => {
    const seen = await db().transaction(async (tx) => {
      await tx.update(users).set({ artistId: null }).where(eq(users.uid, USER_A.uid));
      return artistJob(A_JOB, tx);
    });
    expect(seen).toBe(false);
  });
});

describe('listFacts', () => {
  beforeEach(async () => {
    await seed({
      artistMemory: [
        { artistId: 'flr', kind: 'fact', key: 'home', data: RICHMOND },
        { artistId: 'flr', kind: 'fact', key: 'mr-kill', data: PRIVATE },
      ],
    });
  });

  it("derives the name from the profile, then the artist's stored facts", async () => {
    expect(await listFacts(ARTIST_A, true)).toEqual([NAME_A, RICHMOND, PRIVATE]);
  });

  it('gives only the derived name when the job may not use the memory', async () => {
    expect(await listFacts(ARTIST_A, false)).toEqual([NAME_A]);
  });

  it('follows a rename at once', async () => {
    const [name] = await listFacts({ ...ARTIST_A, name: 'FLR' }, true);
    expect(name).toEqual({ ...NAME_A, value: 'FLR' });
  });

  it("never reads another artist's facts", async () => {
    expect(await listFacts(ARTIST_C, true)).toEqual([{ ...NAME_A, value: ARTIST_C.name }]);
  });

  it('reads stored edits', async () => {
    await db()
      .update(artistMemory)
      .set({ data: { ...RICHMOND, value: 'Norfolk' } })
      .where(fact('home'));
    await db().delete(artistMemory).where(fact('mr-kill'));
    expect(await listFacts(ARTIST_A, true)).toEqual([NAME_A, { ...RICHMOND, value: 'Norfolk' }]);
  });
});

describe('writeFeedback', () => {
  it("routes feedback on the artist's jobs to the artist's memory", async () => {
    await recordFeedback([entry(1), entry(2, 'EDITED')], NATHANS);
    const rows = await artistRows();
    expect(
      rows.map((r) => [r.artistId, r.key, (r.data as Feedback).at, (r.data as Feedback).kind]),
    ).toEqual([
      ['flr', null, 1, 'ACCEPTED'],
      ['flr', null, 2, 'EDITED'],
    ]);
    expect(await jobRows()).toHaveLength(0);
  });

  it("routes feedback on C's jobs to C's own memory", async () => {
    await recordFeedback([entry(1, 'EDITED')], CS);
    expect((await artistRows()).map((r) => r.artistId)).toEqual([ARTIST_C.id]);
    expect(await jobRows()).toHaveLength(0);
  });

  it("keeps feedback on its job when the job's profile isn't the owner's", async () => {
    await recordFeedback([entry(1, 'EDITED')], {
      id: 'job1',
      ownerUid: USER_C.uid,
      artistId: 'flr',
    });
    expect(await artistRows()).toHaveLength(0);
    expect(await jobRows()).toHaveLength(1);
  });

  it("keeps feedback on its job once the owner's artist link is gone", async () => {
    await unlinkA();
    await recordFeedback([entry(1, 'EDITED')], NATHANS);
    expect(await artistRows()).toHaveLength(0);
    expect(await jobRows()).toHaveLength(1);
  });

  it('keeps any other feedback on its job', async () => {
    await recordFeedback([entry(1, 'SKIPPED')], UNLINKED);
    const rows = await jobRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: 'job1', data: { kind: 'SKIPPED' } });
    expect(await artistRows()).toHaveLength(0);
  });

  it('writes nothing for an empty list', async () => {
    await recordFeedback([], NATHANS);
    await recordFeedback([], UNLINKED);
    expect(await artistRows()).toHaveLength(0);
    expect(await jobRows()).toHaveLength(0);
  });

  it('refuses job feedback for a job that does not exist', async () => {
    await expect(recordFeedback([entry(1)], { ...UNLINKED, id: 'ghost' })).rejects.toThrow();
  });

  it("drops a job's feedback with the job", async () => {
    await recordFeedback([entry(1)], UNLINKED);
    await db().delete(jobs);
    expect(await jobRows()).toHaveLength(0);
  });
});

describe('recentFeedback', () => {
  it('returns newest written first, limited, whatever the entries say about time', async () => {
    await recordFeedback([entry(10), entry(30), entry(20)], NATHANS);
    expect((await recentFeedback('flr')).map((f) => f.at)).toEqual([20, 30, 10]);
    expect((await recentFeedback('flr', 2)).map((f) => f.at)).toEqual([20, 30]);
  });

  it('puts a later write ahead of an earlier one', async () => {
    await recordFeedback([entry(30)], NATHANS);
    await recordFeedback([entry(10)], NATHANS);
    expect((await recentFeedback('flr')).map((f) => f.at)).toEqual([10, 30]);
  });

  it('ignores feedback kept on jobs and other artists', async () => {
    await recordFeedback([entry(5)], UNLINKED);
    await recordFeedback([entry(6)], CS);
    expect(await recentFeedback('flr')).toEqual([]);
    expect((await recentFeedback(ARTIST_C.id)).map((f) => f.at)).toEqual([6]);
  });

  it('defaults to 20 rows', async () => {
    await recordFeedback(
      Array.from({ length: 25 }, (_, i) => entry(i)),
      NATHANS,
    );
    const rows = await recentFeedback('flr');
    expect(rows).toHaveLength(20);
    expect(rows[0]!.at).toBe(24);
  });
});

describe('recordPublish', () => {
  const fields: PickFields = { title: 'T', description: 'D', hashtags: [], tags: [] };
  const record = {
    videoId: 'vid1',
    url: 'https://youtu.be/vid1',
    jobId: 'j',
    status: 'VERIFIED' as const,
    at: 5,
    fields,
    recommendation: null,
    influence: null,
    editedBeforeApproval: false,
  };

  const publish = (r: typeof record, artistId = 'flr') =>
    db().transaction((tx) => recordPublish(tx, artistId, r));

  it("stores the publish under its video id, in the job's artist memory", async () => {
    await publish(record);
    await publish({ ...record, videoId: 'vid2' }, ARTIST_C.id);
    expect(await db().select().from(artistMemory)).toEqual([
      { id: expect.any(Number), artistId: 'flr', kind: 'publish', key: 'vid1', data: record },
      {
        id: expect.any(Number),
        artistId: ARTIST_C.id,
        kind: 'publish',
        key: 'vid2',
        data: { ...record, videoId: 'vid2' },
      },
    ]);
  });

  it('replaces an earlier record of the same video', async () => {
    await publish(record);
    await publish({ ...record, at: 9 });
    const rows = await db().select().from(artistMemory).where(memoryOf('flr', 'publish'));
    expect(rows.map((r) => (r.data as typeof record).at)).toEqual([9]);
  });
});

describe('artist_memory', () => {
  const insert = (kind: 'fact' | 'feedback', key: string | null) =>
    db().insert(artistMemory).values({ artistId: 'flr', kind, key, data: {} });

  it.each([
    ['a keyed feedback row', 'feedback', 'k'],
    ['an unkeyed fact row', 'fact', null],
  ] as const)('refuses %s', async (_label, kind, key) => {
    await expect(insert(kind, key)).rejects.toMatchObject({
      cause: { message: expect.stringContaining('artist_memory_kind_check') },
    });
    expect(await db().select().from(artistMemory)).toEqual([]);
  });

  it('accepts an unkeyed feedback row and a keyed fact row', async () => {
    await insert('feedback', null);
    await insert('fact', 'k');
    expect(await db().select().from(artistMemory)).toHaveLength(2);
  });
});

describe('approvalFeedback', () => {
  const proposed: PickFields = {
    title: 'PeekaBoo',
    description: 'Desc',
    hashtags: ['#synthwave'],
    tags: ['synthwave', 'PeekaBoo'],
  };
  const meta = { jobId: 'j', songTitle: 'PeekaBoo', pickVersion: 2, at: 99 };

  it('records only ACCEPTED when nothing changed', () => {
    expect(approvalFeedback(proposed, { ...proposed }, meta)).toEqual([
      { kind: 'ACCEPTED', ...meta, after: 'PeekaBoo' },
    ]);
  });

  it('records an EDITED row per changed field, then ACCEPTED', () => {
    const final: PickFields = {
      title: OFFICIAL_TITLE,
      description: 'Desc',
      hashtags: ['#retrowave'],
      tags: ['synthwave', 'retro'],
    };
    const rows = approvalFeedback(proposed, final, meta);
    expect(rows).toEqual([
      {
        kind: 'EDITED',
        field: 'title',
        before: 'PeekaBoo',
        after: OFFICIAL_TITLE,
        ...meta,
      },
      {
        kind: 'EDITED',
        field: 'tags',
        before: 'synthwave, PeekaBoo',
        after: 'synthwave, retro',
        ...meta,
      },
      { kind: 'ACCEPTED', ...meta, after: OFFICIAL_TITLE },
    ]);
  });

  it('ignores hashtag-only changes and catches description edits', () => {
    const rows = approvalFeedback(
      proposed,
      { ...proposed, hashtags: [], description: 'New desc' },
      meta,
    );
    expect(rows.map((r) => [r.kind, r.field])).toEqual([
      ['EDITED', 'description'],
      ['ACCEPTED', undefined],
    ]);
  });
});

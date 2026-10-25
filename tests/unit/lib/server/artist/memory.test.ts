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
  SEED_FACTS,
  type Fact,
  type Feedback,
} from '#lib/server/artist/memory.js';
import type { PickFields } from '#lib/types.js';
import { seed, truncate } from '../../../../helpers/db';
import { A_JOB, seedJob, USER_A, USER_B, USERS } from '../../../../helpers/pipeline';

const OFFICIAL_TITLE = 'PeekaBoo (Official Video)';
const RICHMOND: Fact = { key: 'home', value: 'Richmond', kind: 'FACT', public: true };

const recordFeedback = (
  entries: Parameters<typeof writeFeedback>[1],
  job: Parameters<typeof writeFeedback>[2],
) => db().transaction(async (tx) => writeFeedback(tx, entries, job));

/** The same stored job, as seen on the artist and unlinked. */
const NATHANS = { id: 'job1', ...A_JOB };
const UNLINKED = { id: 'job1', ownerUid: USER_B.uid, artistId: null };
const unlinkA = () => db().update(users).set({ artistId: null }).where(eq(users.uid, USER_A.uid));

const entry = (at: number, kind: Feedback['kind'] = 'ACCEPTED'): Feedback => ({
  kind,
  at,
  jobId: 'job1',
  songTitle: 'PeekaBoo',
  pickVersion: 1,
});

const facts = () => db().select().from(artistMemory).where(memoryOf('fact'));
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
const fact = (key: string) => and(memoryOf('fact'), eq(artistMemory.key, key));

beforeEach(async () => {
  await truncate();
  await seed(USERS);
  await seedJob({ id: 'job1' });
});

describe('seed facts', () => {
  it('uses the stage name and keeps the inference private', () => {
    const inference = SEED_FACTS.filter((f) => f.kind === 'INFERENCE');
    expect(inference.length).toBeGreaterThan(0);
    expect(inference.every((f) => f.public === false)).toBe(true);
  });
});

describe('artistJob', () => {
  it('is true only when the job and its owner are both linked to the artist', async () => {
    expect(await artistJob(A_JOB)).toBe(true);
  });

  it('is false for a job created without the link', async () => {
    expect(await artistJob({ ownerUid: USER_A.uid, artistId: null })).toBe(false);
  });

  it("is false once the owner's link is removed, for jobs made while linked", async () => {
    await unlinkA();
    expect(await artistJob(A_JOB)).toBe(false);
  });

  it("is false when an unlinked owner's job somehow names the artist", async () => {
    expect(await artistJob({ ownerUid: USER_B.uid, artistId: 'flr' })).toBe(false);
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
  it('seeds the facts on first use', async () => {
    expect(await listFacts()).toEqual(SEED_FACTS);
    const rows = await facts();
    expect(rows.map((r) => [r.artistId, r.key]).sort()).toEqual(
      SEED_FACTS.map((f) => ['flr', f.key]).sort(),
    );
    expect(rows.find((r) => r.key === 'mr-kill')!.data).toMatchObject({
      kind: 'INFERENCE',
      public: false,
    });
  });

  it('reads stored facts instead of reseeding', async () => {
    await listFacts();
    await db().update(artistMemory).set({ data: RICHMOND }).where(fact('home'));
    await db().delete(artistMemory).where(fact('mr-kill'));
    const read = await listFacts();
    expect(read).toHaveLength(SEED_FACTS.length - 1);
    expect(read.find((f) => f.key === 'home')?.value).toBe('Richmond');
    expect((await facts()).some((r) => r.key === 'mr-kill')).toBe(false);
  });

  it('reads stored facts without reseeding a partial table', async () => {
    await seed({ artistMemory: [{ artistId: 'flr', kind: 'fact', key: 'home', data: RICHMOND }] });
    expect(await listFacts()).toEqual([RICHMOND]);
    expect(await facts()).toHaveLength(1);
  });

  it("ignores another artist's facts", async () => {
    await seed({
      artistMemory: [{ artistId: 'other', kind: 'fact', key: 'home', data: RICHMOND }],
    });
    expect(await listFacts()).toEqual(SEED_FACTS);
  });

  it('survives two first uses racing to seed', async () => {
    const [a, b] = await Promise.all([listFacts(), listFacts()]);
    expect(a).toEqual(SEED_FACTS);
    expect(b).toEqual(SEED_FACTS);
    expect(await facts()).toHaveLength(SEED_FACTS.length);
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
    expect((await recentFeedback()).map((f) => f.at)).toEqual([20, 30, 10]);
    expect((await recentFeedback(2)).map((f) => f.at)).toEqual([20, 30]);
  });

  it('puts a later write ahead of an earlier one', async () => {
    await recordFeedback([entry(30)], NATHANS);
    await recordFeedback([entry(10)], NATHANS);
    expect((await recentFeedback()).map((f) => f.at)).toEqual([10, 30]);
  });

  it('ignores feedback kept on jobs and other artists', async () => {
    await recordFeedback([entry(5)], UNLINKED);
    await seed({ artistMemory: [{ artistId: 'other', kind: 'feedback', data: entry(6) }] });
    expect(await recentFeedback()).toEqual([]);
  });

  it('defaults to 20 rows', async () => {
    await recordFeedback(
      Array.from({ length: 25 }, (_, i) => entry(i)),
      NATHANS,
    );
    const rows = await recentFeedback();
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
  };

  const publish = (r: typeof record) => db().transaction((tx) => recordPublish(tx, r));

  it('stores the publish under its video id', async () => {
    await publish(record);
    expect(await db().select().from(artistMemory)).toEqual([
      { id: expect.any(Number), artistId: 'flr', kind: 'publish', key: 'vid1', data: record },
    ]);
  });

  it('replaces an earlier record of the same video', async () => {
    await publish(record);
    await publish({ ...record, at: 9 });
    const rows = await db().select().from(artistMemory).where(memoryOf('publish'));
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

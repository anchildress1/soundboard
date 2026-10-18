// @vitest-environment node
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/core/db';
import {
  artistFacts,
  artistFeedback,
  artistPublishes,
  jobFeedback,
  jobs,
  users,
} from '$lib/server/core/schema';
import {
  approvalFeedback,
  artistJob,
  listFacts,
  recentFeedback,
  writeFeedback,
  recordPublish,
  SEED_FACTS,
  type Fact,
  type Feedback,
} from '$lib/server/artist/memory';
import type { PickFields } from '$lib/types';
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

const facts = () => db().select().from(artistFacts);
const artistRows = () => db().select().from(artistFeedback);
const jobRows = () => db().select().from(jobFeedback);
const fact = (key: string) => and(eq(artistFacts.artistId, 'flr'), eq(artistFacts.key, key));

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
    expect(await listFacts({ seed: true })).toEqual(SEED_FACTS);
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
    await listFacts({ seed: true });
    await db().update(artistFacts).set({ data: RICHMOND }).where(fact('home'));
    await db().delete(artistFacts).where(fact('mr-kill'));
    const read = await listFacts({ seed: true });
    expect(read).toHaveLength(SEED_FACTS.length - 1);
    expect(read.find((f) => f.key === 'home')?.value).toBe('Richmond');
    expect((await facts()).some((r) => r.key === 'mr-kill')).toBe(false);
  });

  it('returns the seeds without writing them when seeding is off', async () => {
    expect(await listFacts({ seed: false })).toEqual(SEED_FACTS);
    expect(await facts()).toEqual([]);
  });

  it('reads stored facts without seeding when seeding is off', async () => {
    await seed({ artistFacts: [{ artistId: 'flr', key: 'home', data: RICHMOND }] });
    expect(await listFacts({ seed: false })).toEqual([RICHMOND]);
  });

  it("ignores another artist's facts", async () => {
    await seed({ artistFacts: [{ artistId: 'other', key: 'home', data: RICHMOND }] });
    expect(await listFacts({ seed: false })).toEqual(SEED_FACTS);
  });

  it('survives two first uses racing to seed', async () => {
    const [a, b] = await Promise.all([listFacts({ seed: true }), listFacts({ seed: true })]);
    expect(a).toEqual(SEED_FACTS);
    expect(b).toEqual(SEED_FACTS);
    expect(await facts()).toHaveLength(SEED_FACTS.length);
  });
});

describe('writeFeedback', () => {
  it("routes feedback on the artist's jobs to the artist's memory", async () => {
    await recordFeedback([entry(1), entry(2, 'EDITED')], NATHANS);
    const rows = await artistRows();
    expect(rows.map((r) => [r.artistId, r.at.getTime(), (r.data as Feedback).kind])).toEqual([
      ['flr', 1, 'ACCEPTED'],
      ['flr', 2, 'EDITED'],
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
  it('returns newest first, limited', async () => {
    await recordFeedback([entry(10), entry(30), entry(20)], NATHANS);
    expect((await recentFeedback()).map((f) => f.at)).toEqual([30, 20, 10]);
    expect((await recentFeedback(2)).map((f) => f.at)).toEqual([30, 20]);
  });

  it('ignores feedback kept on jobs and other artists', async () => {
    await recordFeedback([entry(5)], UNLINKED);
    await seed({ artistFeedback: [{ artistId: 'other', at: new Date(6), data: entry(6) }] });
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

  it('stores the publish under its video id', async () => {
    await recordPublish(record);
    expect(await db().select().from(artistPublishes)).toEqual([
      { artistId: 'flr', videoId: 'vid1', data: record },
    ]);
  });

  it('replaces an earlier record of the same video', async () => {
    await recordPublish(record);
    await recordPublish({ ...record, at: 9 });
    const rows = await db().select().from(artistPublishes);
    expect(rows.map((r) => (r.data as typeof record).at)).toEqual([9]);
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

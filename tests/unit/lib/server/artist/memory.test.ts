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
} from '$lib/server/core/schema';
import {
  approvalFeedback,
  listFacts,
  PUBLIC_FACTS,
  recentFeedback,
  writeFeedback,
  recordPublish,
  SEED_FACTS,
  type Fact,
  type Feedback,
} from '$lib/server/artist/memory';
import type { PickFields } from '$lib/types';
import { seed, truncate } from '../../../../helpers/db';
import { seedJob, USERS } from '../../../../helpers/pipeline';

const OFFICIAL_TITLE = 'PeekaBoo (Official Video)';
const RICHMOND: Fact = { key: 'home', value: 'Richmond', kind: 'FACT', public: true };

const recordFeedback = (
  entries: Parameters<typeof writeFeedback>[1],
  target: Parameters<typeof writeFeedback>[2],
) => db().transaction(async (tx) => writeFeedback(tx, entries, target));

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

  it('exposes only the artist name outside the artist', () => {
    expect(PUBLIC_FACTS).toEqual([
      { key: 'artist-name', value: 'Flies Like Robots', kind: 'FACT', public: true },
    ]);
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
    await recordFeedback([entry(1), entry(2, 'EDITED')], { toArtist: true, jobId: 'job1' });
    const rows = await artistRows();
    expect(rows.map((r) => [r.artistId, r.at.getTime(), (r.data as Feedback).kind])).toEqual([
      ['flr', 1, 'ACCEPTED'],
      ['flr', 2, 'EDITED'],
    ]);
    expect(await jobRows()).toHaveLength(0);
  });

  it('keeps any other feedback on its job', async () => {
    await recordFeedback([entry(1, 'SKIPPED')], { toArtist: false, jobId: 'job1' });
    const rows = await jobRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: 'job1', data: { kind: 'SKIPPED' } });
    expect(await artistRows()).toHaveLength(0);
  });

  it('writes nothing for an empty list', async () => {
    await recordFeedback([], { toArtist: true, jobId: 'job1' });
    await recordFeedback([], { toArtist: false, jobId: 'job1' });
    expect(await artistRows()).toHaveLength(0);
    expect(await jobRows()).toHaveLength(0);
  });

  it('refuses job feedback for a job that does not exist', async () => {
    await expect(recordFeedback([entry(1)], { toArtist: false, jobId: 'ghost' })).rejects.toThrow();
  });

  it("drops a job's feedback with the job", async () => {
    await recordFeedback([entry(1)], { toArtist: false, jobId: 'job1' });
    await db().delete(jobs);
    expect(await jobRows()).toHaveLength(0);
  });
});

describe('recentFeedback', () => {
  it('returns newest first, limited', async () => {
    await recordFeedback([entry(10), entry(30), entry(20)], { toArtist: true, jobId: 'j' });
    expect((await recentFeedback()).map((f) => f.at)).toEqual([30, 20, 10]);
    expect((await recentFeedback(2)).map((f) => f.at)).toEqual([30, 20]);
  });

  it('ignores feedback kept on jobs and other artists', async () => {
    await recordFeedback([entry(5)], { toArtist: false, jobId: 'job1' });
    await seed({ artistFeedback: [{ artistId: 'other', at: new Date(6), data: entry(6) }] });
    expect(await recentFeedback()).toEqual([]);
  });

  it('defaults to 20 rows', async () => {
    await recordFeedback(
      Array.from({ length: 25 }, (_, i) => entry(i)),
      { toArtist: true, jobId: 'j' },
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

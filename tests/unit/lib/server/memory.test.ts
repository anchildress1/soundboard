// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../helpers/fake-firestore';
import { db, resetClients } from '$lib/server/clients';
import {
  approvalFeedback,
  ARTIST_ID,
  ARTIST_NAME,
  listFacts,
  PUBLIC_FACTS,
  recentFeedback,
  writeFeedback,
  recordPublish,
  SEED_FACTS,
  type Feedback,
} from '$lib/server/memory';
import type { PickFields } from '$lib/types';

const recordFeedback = (
  entries: Parameters<typeof writeFeedback>[1],
  target: Parameters<typeof writeFeedback>[2],
) => db().runTransaction(async (tx) => writeFeedback(tx, entries, target));

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

const entry = (at: number, kind: Feedback['kind'] = 'ACCEPTED'): Feedback => ({
  kind,
  jobId: 'job1',
  songTitle: 'PeekaBoo',
  pickVersion: 1,
  at,
});

const keysUnder = (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix));

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
});

describe('seed facts', () => {
  it('uses the stage name and keeps the inference private', () => {
    expect(ARTIST_ID).toBe('flr');
    expect(ARTIST_NAME).toBe('Flies Like Robots');
    const inference = SEED_FACTS.filter((f) => f.kind === 'INFERENCE');
    expect(inference.length).toBeGreaterThan(0);
    expect(inference.every((f) => f.public === false)).toBe(true);
  });

  it('exposes only the artist name to visitor jobs', () => {
    expect(PUBLIC_FACTS).toEqual([
      { key: 'artist-name', value: 'Flies Like Robots', kind: 'FACT', public: true },
    ]);
  });
});

describe('listFacts', () => {
  it('seeds the facts on first use', async () => {
    expect(await listFacts()).toEqual(SEED_FACTS);
    expect(keysUnder('artists/flr/facts/').sort()).toEqual(
      SEED_FACTS.map((f) => `artists/flr/facts/${f.key}`).sort(),
    );
    expect(store.get('artists/flr/facts/mr-kill')).toMatchObject({
      kind: 'INFERENCE',
      public: false,
    });
  });

  it('reads stored facts instead of reseeding', async () => {
    await listFacts();
    store.set('artists/flr/facts/home', {
      key: 'home',
      value: 'Richmond',
      kind: 'FACT',
      public: true,
    });
    store.delete('artists/flr/facts/mr-kill');
    const facts = await listFacts();
    expect(facts).toHaveLength(SEED_FACTS.length - 1);
    expect(facts.find((f) => f.key === 'home')?.value).toBe('Richmond');
    expect(store.has('artists/flr/facts/mr-kill')).toBe(false);
  });

  it('requires a project id', async () => {
    vi.stubEnv('GCP_PROJECT_ID', '');
    await expect(listFacts()).rejects.toThrow('GCP_PROJECT_ID');
  });
});

describe('writeFeedback', () => {
  it("routes allowlisted feedback to the artist's memory", async () => {
    await recordFeedback([entry(1), entry(2, 'EDITED')], { allowlisted: true, jobId: 'job1' });
    expect(keysUnder('artists/flr/feedback/')).toHaveLength(2);
    expect(keysUnder('jobs/')).toHaveLength(0);
  });

  it('keeps visitor feedback on the job', async () => {
    await recordFeedback([entry(1, 'SKIPPED')], { allowlisted: false, jobId: 'job9' });
    const keys = keysUnder('jobs/job9/feedback/');
    expect(keys).toHaveLength(1);
    expect(store.get(keys[0]!)).toMatchObject({ kind: 'SKIPPED' });
    expect(keysUnder('artists/')).toHaveLength(0);
  });

  it('writes nothing for an empty list', async () => {
    await recordFeedback([], { allowlisted: true, jobId: 'job1' });
    expect(store.size).toBe(0);
  });
});

describe('recentFeedback', () => {
  it('returns newest first, limited', async () => {
    await recordFeedback([entry(10), entry(30), entry(20)], { allowlisted: true, jobId: 'j' });
    expect((await recentFeedback()).map((f) => f.at)).toEqual([30, 20, 10]);
    expect((await recentFeedback(2)).map((f) => f.at)).toEqual([30, 20]);
  });

  it('ignores visitor feedback', async () => {
    await recordFeedback([entry(5)], { allowlisted: false, jobId: 'j' });
    expect(await recentFeedback()).toEqual([]);
  });

  it('defaults to 20 rows', async () => {
    await recordFeedback(
      Array.from({ length: 25 }, (_, i) => entry(i)),
      { allowlisted: true, jobId: 'j' },
    );
    const rows = await recentFeedback();
    expect(rows).toHaveLength(20);
    expect(rows[0]!.at).toBe(24);
  });
});

describe('recordPublish', () => {
  it('stores the publish under its video id', async () => {
    const fields: PickFields = { title: 'T', description: 'D', hashtags: [], tags: [] };
    const record = {
      videoId: 'vid1',
      url: 'https://youtu.be/vid1',
      jobId: 'j',
      fields,
      status: 'VERIFIED' as const,
      at: 5,
    };
    await recordPublish(record);
    expect(store.get('artists/flr/publishes/vid1')).toEqual(record);
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
      title: 'PeekaBoo (Official Video)',
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
        after: 'PeekaBoo (Official Video)',
        ...meta,
      },
      {
        kind: 'EDITED',
        field: 'tags',
        before: 'synthwave, PeekaBoo',
        after: 'synthwave, retro',
        ...meta,
      },
      { kind: 'ACCEPTED', ...meta, after: 'PeekaBoo (Official Video)' },
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

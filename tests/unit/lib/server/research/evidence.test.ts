// @vitest-environment node
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, query } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { jobResearch } from '#lib/server/core/schema.js';
import {
  evidenceExpiry,
  readEvidence,
  resolveRef,
  saveEvidence,
  type Peer,
  type PeerEvidence,
  type PeerRelease,
} from '#lib/server/research/evidence.js';
import { claim } from '#lib/server/research/runs.js';
import { seed, truncate } from '../../../../helpers/db';
import { A_JOB, seedJob, USERS, USER_A, USER_C } from '../../../../helpers/pipeline';

const asA = <T>(operation: () => Promise<T>) => withIdentity(USER_A.uid, operation);
const DAY = 24 * 60 * 60_000;

const peer = (ref: string, title: string): Peer => ({
  ref,
  channelId: `UC${ref}`,
  title,
  basis: 'metadata-only',
  explanation: 'Same synth palette.',
  stats: { subscribers: 1200, hidden: false, videos: 40, views: 90_000 },
  bracket: 1000,
  relation: 'next',
  secondary: false,
});
const release = (ref: string, peerRef: string): PeerRelease => ({
  ref,
  peer: peerRef,
  videoId: `v-${ref}`,
  title: 'Night Drive',
  description: '',
  tags: [],
  hashtags: [],
  durationSec: 200,
  publishedAt: '2026-08-01T00:00:00Z',
  stats: { views: 1000, likes: 50, comments: 5 },
  selectedAs: 'newest',
});
const evidence = (patch: Partial<PeerEvidence> = {}): PeerEvidence => ({
  query: 'synthwave music',
  artist: { stats: null, bracket: null },
  candidates: [],
  peers: [],
  releases: [],
  skipped: [],
  ...patch,
});

const researchRow = (runId: string, body: PeerEvidence, retrievedAt = new Date()) => ({
  runId,
  jobId: 'j1',
  retrievedAt,
  evidence: body,
});

beforeEach(async () => {
  await truncate();
  await seed(USERS);
  await seedJob({ ...A_JOB, id: 'j1', state: 'PICK' });
});

describe('saveEvidence', () => {
  beforeEach(() =>
    seed({
      researchRuns: [
        {
          jobId: 'j1',
          id: 'run-1',
          ownerUid: USER_A.uid,
          artistId: USER_A.artistId,
          stage: 'discover',
        },
      ],
    }),
  );

  const claimed = async () => {
    const result = await asA(() => claim({ jobId: 'j1', uid: USER_A.uid, runId: 'run-1', seq: 0 }));
    if (result.kind !== 'claimed') throw new Error('not claimed');
    return result.token;
  };

  it('keeps the first save time when a later batch saves again', async () => {
    const token = await claimed();
    await asA(() => query((tx) => saveEvidence(tx, 'run-1', token, evidence({ query: 'a' }))));
    const first = new Date(Date.now() - 3 * DAY);
    await db().update(jobResearch).set({ retrievedAt: first });
    await asA(() => query((tx) => saveEvidence(tx, 'run-1', token, evidence({ query: 'b' }))));
    const [row] = await db().select().from(jobResearch).where(eq(jobResearch.runId, 'run-1'));
    expect(row?.retrievedAt).toEqual(first);
    expect(row?.evidence).toMatchObject({ query: 'b' });
  });

  it('refuses a save without the live claim', async () => {
    await claimed();
    await expect(
      asA(() => query((tx) => saveEvidence(tx, 'run-1', 'not-the-token', evidence()))),
    ).rejects.toThrow();
    expect(await db().select().from(jobResearch)).toEqual([]);
  });
});

describe('readEvidence', () => {
  it("returns the owner's fresh evidence with its retrieval time", async () => {
    const at = new Date(Date.now() - DAY);
    await seed({ jobResearch: [researchRow('run-1', evidence({ query: 'q' }), at)] });
    expect(await asA(() => readEvidence('run-1'))).toEqual({
      retrievedAt: at,
      evidence: evidence({ query: 'q' }),
    });
  });

  it('hides evidence 29 days old', async () => {
    await seed({
      jobResearch: [researchRow('run-1', evidence(), new Date(Date.now() - 29 * DAY))],
    });
    expect(await asA(() => readEvidence('run-1'))).toBeNull();
  });

  it("never shows another user's evidence", async () => {
    await seed({ jobResearch: [researchRow('run-1', evidence())] });
    expect(await withIdentity(USER_C.uid, () => readEvidence('run-1'))).toBeNull();
  });

  it('returns null for an unknown run', async () => {
    expect(await asA(() => readEvidence('nope'))).toBeNull();
  });
});

describe('resolveRef', () => {
  const old = evidence({
    peers: [peer('P1', 'Old Peer')],
    releases: [release('P1-R1', 'P1'), release('P2-R1', 'P2')],
  });

  it("resolves an old pick's P1 against its own run after a newer run saved another P1", async () => {
    await seed({
      jobResearch: [
        researchRow('run-old', old),
        researchRow('run-new', evidence({ peers: [peer('P1', 'New Peer')] })),
      ],
    });
    const stored = await asA(() => readEvidence('run-old'));
    expect(resolveRef(stored?.evidence ?? null, 'P1', null)).toEqual({
      ref: 'P1',
      peer: peer('P1', 'Old Peer'),
    });
  });

  it('resolves a release with its peer', () => {
    expect(resolveRef(old, 'P1-R1', null)).toEqual({
      ref: 'P1-R1',
      release: release('P1-R1', 'P1'),
      peer: peer('P1', 'Old Peer'),
    });
  });

  it('resolves a release whose peer is missing with a null peer', () => {
    expect(resolveRef(old, 'P2-R1', null)).toMatchObject({ ref: 'P2-R1', peer: null });
  });

  it('marks a ref expired with the stored date once the cleanup took the row', async () => {
    const expiresAt = '2026-11-20T00:00:00.000Z';
    await seed({ jobResearch: [researchRow('run-old', old)] });
    await db().delete(jobResearch).where(eq(jobResearch.runId, 'run-old'));
    const stored = await asA(() => readEvidence('run-old'));
    expect(resolveRef(stored?.evidence ?? null, 'P1', expiresAt)).toEqual({
      ref: 'P1',
      expired: true,
      expiresAt,
    });
  });

  it('marks an unknown ref expired', () => {
    expect(resolveRef(old, 'P9', null)).toEqual({ ref: 'P9', expired: true, expiresAt: null });
  });
});

describe('evidenceExpiry', () => {
  it('is 29 days after retrieval', () => {
    expect(evidenceExpiry(new Date('2026-10-01T12:00:00Z'))).toBe('2026-10-30T12:00:00.000Z');
  });
});

// @vitest-environment node
import * as Sentry from '@sentry/sveltekit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { jobResearch, jobs, researchRuns } from '#lib/server/core/schema.js';
import { runDelivery, type Stages } from '#lib/server/research/delivery.js';
import type { Candidate, PeerEvidence } from '#lib/server/research/evidence.js';
import { match } from '#lib/server/research/match.js';
import { seed, truncate } from '../../../../helpers/db';
import { busy429, geminiError, interaction } from '../../../../helpers/gemini';
import { agentSpanIO, clearAgentSpan } from '../../../../helpers/agent-span';
import { A_JOB, ANALYSIS, json, seedJob, USERS, USER_A } from '../../../../helpers/pipeline';

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getAccessToken = () => Promise.resolve('tasks-access-token');
  },
}));

const DELIVERY = { jobId: 'j1', uid: USER_A.uid, runId: 'run-1', seq: 0 };
const asA = <T>(operation: () => Promise<T>) => withIdentity(USER_A.uid, operation);
const stats = { subscribers: 2000, hidden: false, videos: 10, views: 5000 };

/** Candidate `n`, in range `relation`, with a sample whose ID is a valid watch ID. */
const candidate = (n: number, relation: Candidate['relation'], over: Partial<Candidate> = {}) => ({
  channelId: `UC${n}`,
  title: `Channel ${n}`,
  description: `About ${n}`,
  uploadsPlaylist: `UU${n}`,
  stats,
  bracket: 1000 as const,
  relation,
  sample: {
    videoId: `video${String(n).padStart(6, '0')}`,
    title: `Upload ${n}`,
    tags: ['synthwave'],
  },
  ...over,
});

const evidence = (candidates: Candidate[]): PeerEvidence => ({
  query: 'synthwave music',
  artist: { stats: null, bracket: 100 },
  candidates,
  peers: [],
  releases: [],
  skipped: [],
});

type Verdict = { channelKind?: string; sound?: string };
/** Channel number → what the model answers for it; anything else is a match. */
let verdicts: Record<number, Verdict>;
let geminiCalls: { channel: number; heard: boolean }[];
const fetchMock = vi.fn<typeof fetch>();

fetchMock.mockName('fetch');
function answer(refuse: (channel: number) => Response | null = () => null) {
  fetchMock.mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('cloudtasks')) return Promise.resolve(json({}));
    if (!url.includes('generativelanguage')) throw new Error(`unexpected fetch ${url}`);
    const body = String((init as RequestInit).body);
    const channel = Number(/Channel (\d+)/.exec(body)![1]);
    const heard = body.includes('youtube.com/watch');
    geminiCalls.push({ channel, heard });
    const refused = heard ? refuse(channel) : null;
    if (refused) return Promise.resolve(refused);
    const verdict = verdicts[channel] ?? {};
    return Promise.resolve(
      interaction(
        JSON.stringify({
          channelKind: 'artist',
          sound: 'same',
          explanation: `Channel ${channel} sounds alike.`,
          ...verdict,
        }),
      ),
    );
  });
}

const runAt = (patch: Partial<typeof researchRuns.$inferInsert> = {}) =>
  seed({
    researchRuns: [
      {
        jobId: 'j1',
        id: 'run-1',
        ownerUid: USER_A.uid,
        artistId: USER_A.artistId,
        stage: 'match',
        ...patch,
      },
    ],
  });
const store = (candidates: Candidate[]) =>
  seed({
    jobResearch: [
      { runId: 'run-1', jobId: 'j1', retrievedAt: new Date(), evidence: evidence(candidates) },
    ],
  });
const storedRun = async () =>
  (await db().select().from(researchRuns).where(eq(researchRuns.jobId, 'j1')))[0]!;
const storedEvidence = async () =>
  (await db().select().from(jobResearch).where(eq(jobResearch.runId, 'run-1')))[0]!
    .evidence as PeerEvidence;

/** Only match runs; the stages around it end or hand over. */
const ONLY_MATCH: Stages = {
  learn: () => Promise.resolve({ done: 0, stage: 'discover', cursor: 0 }),
  discover: () => Promise.resolve({ done: 0, stage: 'match', cursor: 0 }),
  match,
  releases: () => Promise.resolve({ done: 1, stage: 'done', cursor: 0 }),
};
const deliver = (seq: number) => runDelivery({ ...DELIVERY, seq }, ONLY_MATCH);

beforeEach(async () => {
  await truncate();
  await seed(USERS);
  await seedJob({ ...A_JOB, id: 'j1', state: 'PICK' });
  await db()
    .update(jobs)
    .set({ chunks: [{ index: 0, analysis: ANALYSIS }] })
    .where(eq(jobs.id, 'j1'));
  clearAgentSpan();
  verdicts = {};
  geminiCalls = [];
  fetchMock.mockReset();
  answer();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  vi.stubEnv('PEER_HEARING', '1');
  vi.stubEnv('RESEARCH_QUEUE', 'projects/p/locations/us-central1/queues/soundboard-research');
  vi.stubEnv('RESEARCH_TASK_URL', 'https://soundboard-1.us-central1.run.app/api/research/task');
  vi.stubEnv('RESEARCH_TASK_SA', 'research@p.iam.gserviceaccount.com');
  vi.mocked(Sentry.startSpan).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('match: who is kept', () => {
  beforeEach(runAt);

  it('keeps an artist whose sound is the same, numbering peers in selection order', async () => {
    await store([candidate(1, 'next'), candidate(2, 'next'), candidate(3, 'same')]);
    await deliver(0);

    const { peers } = await storedEvidence();
    expect(peers.map((p) => [p.ref, p.channelId, p.relation, p.secondary, p.basis])).toEqual([
      ['P1', 'UC1', 'next', false, 'heard'],
      ['P2', 'UC2', 'next', false, 'heard'],
      ['P3', 'UC3', 'same', false, 'heard'],
    ]);
    expect(peers[0]).toMatchObject({
      title: 'Channel 1',
      explanation: 'Channel 1 sounds alike.',
      stats,
      bracket: 1000,
    });
    expect(await storedRun()).toMatchObject({
      stage: 'releases',
      cursor: 0,
      limits: ['same-range-fallback'],
    });
  });

  it('skips a label, compilation, curator, uncertain or different-sounding channel', async () => {
    verdicts = {
      1: { channelKind: 'label' },
      2: { channelKind: 'compilation' },
      3: { channelKind: 'curator' },
      4: { channelKind: 'uncertain' },
      5: { sound: 'different' },
      6: { sound: 'uncertain' },
    };
    await store([1, 2, 3, 4, 5, 6, 7].map((n) => candidate(n, 'next')));
    await deliver(0);

    const stored = await storedEvidence();
    expect(stored.peers.map((p) => p.channelId)).toEqual(['UC7']);
    expect(stored.candidates.map((c) => c.match?.kept)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('judges a channel with no public upload without a model call', async () => {
    await store([candidate(1, 'next', { sample: null }), candidate(2, 'next')]);
    await deliver(0);
    expect(geminiCalls.map((c) => c.channel)).toEqual([2]);
    const stored = await storedEvidence();
    expect(stored.candidates[0]?.match).toEqual({
      kept: false,
      basis: 'metadata-only',
      explanation: 'No public upload to compare.',
    });
    expect(stored.peers.map((p) => p.ref)).toEqual(['P1']);
  });

  it('stops at 5 next-range peers before any same-range candidate is judged', async () => {
    await store([
      ...[1, 2, 3, 4, 5, 6].map((n) => candidate(n, 'next')),
      candidate(7, 'same'),
      candidate(8, 'two-up'),
    ]);
    await deliver(0);

    expect(geminiCalls.map((c) => c.channel)).toEqual([1, 2, 3, 4, 5]);
    const stored = await storedEvidence();
    expect(stored.peers.map((p) => p.channelId)).toEqual(['UC1', 'UC2', 'UC3', 'UC4', 'UC5']);
    expect(await storedRun()).toMatchObject({ stage: 'releases', cursor: 0 });
  });

  it('counts only next-range peers toward the stop', async () => {
    verdicts = { 1: { sound: 'different' }, 2: { sound: 'different' } };
    await store([...[1, 2, 3, 4, 5, 6, 7].map((n) => candidate(n, 'next')), candidate(8, 'same')]);
    await deliver(0);
    // Two skipped next-range channels push the fifth keeper to the seventh; the same-range one is spared.
    expect(geminiCalls.map((c) => c.channel)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('fills to 3 with same-range peers and adds two-up peers as secondary', async () => {
    await store([
      candidate(1, 'next'),
      candidate(2, 'same'),
      candidate(3, 'same'),
      candidate(4, 'same'),
      candidate(5, 'two-up'),
    ]);
    await deliver(0);

    const { peers } = await storedEvidence();
    expect(peers.map((p) => [p.channelId, p.secondary])).toEqual([
      ['UC1', false],
      ['UC2', false],
      ['UC3', false],
      ['UC5', true],
    ]);
    expect((await storedRun()).limits).toEqual(['same-range-fallback']);
  });

  it('keeps search order when the artist range is unknown', async () => {
    await store([candidate(1, null), candidate(2, null), candidate(3, null)]);
    await deliver(0);
    expect((await storedEvidence()).peers.map((p) => [p.ref, p.relation])).toEqual([
      ['P1', null],
      ['P2', null],
      ['P3', null],
    ]);
  });
});

describe('match: hearing and basis', () => {
  beforeEach(runAt);

  it('labels a match heard when the clip was part of the call', async () => {
    await store([candidate(1, 'next')]);
    await deliver(0);
    expect(geminiCalls).toEqual([{ channel: 1, heard: true }]);
    expect((await storedEvidence()).peers[0]?.basis).toBe('heard');
  });

  it('matches on metadata alone with hearing off and says so', async () => {
    vi.stubEnv('PEER_HEARING', '');
    await store([1, 2, 3].map((n) => candidate(n, 'next')));
    await deliver(0);
    expect(geminiCalls.every((c) => !c.heard)).toBe(true);
    const stored = await storedEvidence();
    expect(stored.peers.every((p) => p.basis === 'metadata-only')).toBe(true);
    expect((await storedRun()).limits).toEqual(['hearing-off']);
  });

  it('labels a private sample metadata-only after Gemini refuses to open it', async () => {
    answer((channel) => (channel === 2 ? geminiError(403, 'PERMISSION_DENIED') : null));
    await store([1, 2, 3].map((n) => candidate(n, 'next')));
    await deliver(0);

    expect(geminiCalls).toEqual([
      { channel: 1, heard: true },
      { channel: 2, heard: true },
      { channel: 2, heard: false },
      { channel: 3, heard: true },
    ]);
    const { peers } = await storedEvidence();
    expect(peers.map((p) => p.basis)).toEqual(['heard', 'metadata-only', 'heard']);
  });
});

describe('match: limits', () => {
  beforeEach(runAt);

  it('ends the run with no-peers when nothing is kept', async () => {
    verdicts = { 1: { sound: 'different' }, 2: { channelKind: 'curator' } };
    await store([candidate(1, 'next'), candidate(2, 'next')]);
    await deliver(0);
    expect(await storedRun()).toMatchObject({
      stage: 'done',
      limits: ['no-peers'],
      consecutiveFailures: 0,
    });
    expect((await storedEvidence()).peers).toEqual([]);
  });

  it('adds few-peers under 3', async () => {
    verdicts = { 3: { sound: 'different' } };
    await store([1, 2, 3].map((n) => candidate(n, 'next')));
    await deliver(0);
    expect(await storedRun()).toMatchObject({ stage: 'releases', limits: ['few-peers'] });
  });

  it('ends with no-peers when the evidence is gone mid-run', async () => {
    const batch = await asA(async () =>
      match({ run: await storedRun(), deadline: Date.now() + 110_000 }),
    );
    expect(batch).toEqual({ done: 1, stage: 'done', cursor: 0, limits: ['no-peers'] });
    expect(geminiCalls).toEqual([]);
  });

  it('fails the batch, not the run, on a bad PEER_HEARING value', async () => {
    vi.stubEnv('PEER_HEARING', 'yes');
    await store([candidate(1, 'next')]);
    await deliver(0);
    expect(await storedRun()).toMatchObject({ stage: 'match', consecutiveFailures: 1 });
  });
});

describe('match: batches, waits and redelivery', () => {
  beforeEach(runAt);

  it('keeps the matches made before a 429 and resumes after them', async () => {
    let calls = 0;
    answer(() => null);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => {
      if (String(input).includes('generativelanguage') && (calls += 1) === 2) {
        return Promise.resolve(busy429());
      }
      return base(input, init);
    });
    await store([1, 2, 3].map((n) => candidate(n, 'next')));

    await deliver(0);
    expect(await storedRun()).toMatchObject({
      stage: 'match',
      cursor: 1,
      wait: 'model busy',
      consecutiveFailures: 0,
    });
    const partial = await storedEvidence();
    expect(partial.candidates.map((c) => c.match?.kept)).toEqual([true, undefined, undefined]);
    expect(partial.peers).toEqual([]);

    await deliver(1);
    expect(await storedRun()).toMatchObject({ stage: 'releases', cursor: 0, wait: null, seq: 2 });
    expect((await storedEvidence()).peers.map((p) => p.ref)).toEqual(['P1', 'P2', 'P3']);
    // Candidate 1 was not judged again after the wait.
    expect(geminiCalls.map((c) => c.channel)).toEqual([1, 2, 3]);
  });

  it('waits on a 429 before any match, leaving the cursor and streak alone', async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(String(input).includes('cloudtasks') ? json({}) : busy429()),
    );
    await store([candidate(1, 'next')]);
    await deliver(0);
    await deliver(1);
    expect(await storedRun()).toMatchObject({
      stage: 'match',
      cursor: 0,
      wait: 'model busy',
      consecutiveFailures: 0,
    });
  });

  it('spans several deliveries when the matches outlast one step', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Each call takes 35 s of the 110 s step, so a delivery judges three.
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => {
      if (String(input).includes('generativelanguage')) vi.setSystemTime(Date.now() + 35_000);
      return base(input, init);
    });
    await store([1, 2, 3, 4, 5].map((n) => candidate(n, 'next')));

    await deliver(0);
    expect(await storedRun()).toMatchObject({ stage: 'match', cursor: 3, seq: 1 });
    await deliver(1);
    expect(await storedRun()).toMatchObject({ stage: 'releases', cursor: 0, seq: 2 });
    expect((await storedEvidence()).peers).toHaveLength(5);
  });

  it('does not duplicate peers when a finished delivery arrives again', async () => {
    await store([1, 2, 3].map((n) => candidate(n, 'next')));
    await deliver(0);
    const before = await storedEvidence();
    const calls = geminiCalls.length;

    expect(await deliver(0)).toBe(200);

    expect(await storedEvidence()).toEqual(before);
    expect(geminiCalls).toHaveLength(calls);
    expect(before.peers.map((p) => p.ref)).toEqual(['P1', 'P2', 'P3']);
  });

  it('judges again from the stored evidence when a batch was lost before its commit', async () => {
    await store([1, 2, 3].map((n) => candidate(n, 'next')));
    const first = await asA(async () =>
      match({ run: await storedRun(), deadline: Date.now() + 110_000 }),
    );
    expect(first.stage).toBe('releases');
    // Nothing was committed, so the redelivery starts from the stored evidence and ends the same.
    await deliver(0);
    expect((await storedEvidence()).peers.map((p) => p.ref)).toEqual(['P1', 'P2', 'P3']);
  });
});

describe('match: the agent span', () => {
  beforeEach(runAt);

  it('records no peer value in the input and replaces the ones the reply echoes', async () => {
    verdicts = { 1: {} };
    await store([candidate(1, 'next')]);
    await deliver(0);

    const { input, output } = agentSpanIO();
    expect(input[0]!['gen_ai.input.messages']).toContain('[YouTube peers: 1]');
    expect(input[0]!['gen_ai.input.messages']).not.toContain('Channel 1');
    expect(output).toEqual([expect.stringContaining('[YouTube data] sounds alike')]);
  });
});

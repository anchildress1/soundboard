// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { seed, truncate } from '../../../../helpers/db';
import { agentSpanIO, clearAgentSpan } from '../../../../helpers/agent-span';
import {
  A_JOB,
  ANALYSIS,
  ARTIST,
  CHANNEL_A,
  child,
  REFRESH_A,
  completion,
  defaultHandlers,
  headers,
  JPEG,
  jobDoc,
  json,
  MEASURE_STDERR,
  probeJson,
  RAW_PICK,
  RETROWAVE,
  SESSION_URI,
  seedJob,
  SYNTHWAVE,
  USER_A,
  USERS,
  type Handler,
  type Run,
} from '../../../../helpers/pipeline';
import { captureException, captureMessage } from '../../../../mocks/sentry';
import { resetClients } from '$lib/server/core/clients';
import { db } from '$lib/server/core/db';
import {
  artistBrand,
  artistFacts,
  artistFeedback,
  artistPublishes,
  connections,
  jobChunks,
  jobPicks,
  jobs,
  users,
} from '$lib/server/core/schema';
import { retry } from '$lib/server/jobs/actions';
import { getJob, MAX_MINUTES, outcomeUnknown, type JobDoc } from '$lib/server/jobs/jobs';
import { jobSet, type JobPatch } from '$lib/server/jobs/rows';
import { failurePatch, runStep, VERIFY_ATTEMPTS } from '$lib/server/pipeline/pipeline';
import { clearStatsCache, quotaResetAt } from '$lib/server/platforms/youtube/youtube';

const WAKING = 'waking model';
const ARTIST_NAME_KEY = 'artist-name';
const BAD_PICK_JSON = '{"title": 1}';
const WAITING_ON_YOUTUBE = 'waiting on YouTube';
const RECONNECT = 'reconnect YouTube';
const OUTCOME_UNKNOWN = 'upload outcome unknown';
const DAILY_LIMIT = 'Daily upload limit reached. Try tomorrow.';
const A_TOKEN = `Bearer access:${REFRESH_A}`;
const SOURCE_OBJECT = 'uploads/p1';
// Far from the Pacific midnight reset, so the step and the assertion see the same reset.
const NOON_PACIFIC = Date.parse('2026-10-18T19:00:00Z');

const h = vi.hoisted(() => ({
  objects: new Map<string, { size?: string; contentType?: string }>(),
  spawn: vi.fn(),
  upload: vi.fn(),
  refreshError: null as Error | null,
}));

vi.mock('@google-cloud/kms', () => import('../../../../e2e/fakes/kms'));

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      return {
        upload: h.upload,
        file: (object: string) => ({
          getSignedUrl: async ({ action }: { action: string }) => [
            `https://storage.googleapis.com/${name}/${object}?sig=${action}`,
          ],
          exists: async () => [h.objects.has(object)],
          getMetadata: async () => [h.objects.get(object)],
        }),
      };
    }
  },
}));

// Each grant mints its own token, so a request's Authorization header names the grant behind it.
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    refresh = '';
    setCredentials(credentials: { refresh_token: string }) {
      this.refresh = credentials.refresh_token;
    }
    async getAccessToken() {
      if (h.refreshError) throw h.refreshError;
      return { token: `access:${this.refresh}` };
    }
  },
}));

vi.mock('node:child_process', () => ({ spawn: h.spawn }));

let tools: { probe: Run; measure: Run; window: Run };

let handlers: Handler[];
const calls: { url: string; init: RequestInit }[] = [];

/** Later registrations win over the defaults. */
const on = (test: RegExp, reply: Handler['reply']) => handlers.unshift({ test, reply });
const called = (test: RegExp) => calls.filter((c) => test.test(c.url));
const chatBodies = () =>
  called(/\/v1\/chat\/completions$/).map(
    (c) => JSON.parse(String(c.init.body)) as Record<string, unknown>,
  );

const put = (patch: Partial<JobDoc> = {}) => seedJob(patch);
const saved = async () => (await getJob('j1'))!;
const patchJob = (fields: JobPatch) =>
  db().update(jobs).set(jobSet(fields)).where(eq(jobs.id, 'j1'));
const claimToken = async () =>
  (await db().select({ token: jobs.claimToken }).from(jobs).where(eq(jobs.id, 'j1')))[0]!.token;
const chunkAt = async (index: number) =>
  (
    await db()
      .select({ data: jobChunks.data })
      .from(jobChunks)
      .where(and(eq(jobChunks.jobId, 'j1'), eq(jobChunks.index, index)))
  )[0]?.data as Record<string, unknown> | undefined;
const pickAt = async (version: number) =>
  (
    await db()
      .select({ data: jobPicks.data })
      .from(jobPicks)
      .where(and(eq(jobPicks.jobId, 'j1'), eq(jobPicks.version, version)))
  )[0]?.data as Record<string, unknown> | undefined;
const unlinkA = () => db().update(users).set({ artistId: null }).where(eq(users.uid, USER_A.uid));
const revokeA = () =>
  db()
    .update(connections)
    .set({ status: 'revoked', tokenCiphertext: null })
    .where(eq(connections.uid, USER_A.uid));
const artistRowCount = async () =>
  (
    await Promise.all(
      [artistFacts, artistFeedback, artistPublishes, artistBrand].map((t) => db().select().from(t)),
    )
  ).flat().length;
const FIELDS = {
  title: 'PeekaBoo',
  description: 'd #synthwave',
  hashtags: [SYNTHWAVE],
  tags: ['a'],
};
const PROBE = { durationSec: 40, width: 1920, height: 1080, hasAudio: true };
const MEASURED = {
  integratedLufs: -13.8,
  truePeakDbtp: -0.4,
  peakLevelDb: -2.1,
  clippedSamples: 0,
  silences: [],
};

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  vi.stubEnv('YOUTUBE_API_KEY', 'key');
  vi.stubEnv('FLR_CHANNEL_ID', 'UCflr');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'secret');
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  resetClients();
  await truncate();
  await seed(USERS);
  clearStatsCache();
  h.objects.clear();
  h.refreshError = null;
  h.objects.set('uploads/j1', { size: '1000', contentType: 'video/quicktime' });
  tools = {
    probe: { stdout: probeJson(95) },
    measure: { stderr: MEASURE_STDERR },
    window: { stdout: Buffer.from('RIFFwav'), fd3: JPEG, stderr: MEASURE_STDERR },
  };
  h.spawn.mockReset();
  h.spawn.mockImplementation((command: string, args: string[]) => {
    if (command === 'ffprobe') return child(tools.probe);
    return child(args.includes('-ss') ? tools.window : tools.measure);
  });
  handlers = defaultHandlers();
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      const handler = handlers.find((x) => x.test.test(url));
      if (!handler) throw new Error(`unexpected fetch ${url}`);
      return handler.reply(url, init);
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('runStep: AWAITING_UPLOAD', () => {
  it('moves to PREP once the browser upload lands', async () => {
    expect(await runStep(await put({ state: 'AWAITING_UPLOAD' }))).toEqual({});
    expect((await saved()).state).toBe('PREP');
  });

  it('keeps waiting while the object is missing', async () => {
    h.objects.clear();
    expect(await runStep(await put({ state: 'AWAITING_UPLOAD' }))).toEqual({});
    expect((await saved()).state).toBe('AWAITING_UPLOAD');
  });
});

describe('runStep: states the page does not drive', () => {
  it.each(['REVIEW', 'VERIFIED', 'FAILED', 'DISCARDED'] as const)(
    'leaves %s untouched',
    async (state) => {
      expect(await runStep(await put({ state }))).toEqual({});
      expect((await saved()).state).toBe(state);
      expect(await claimToken()).toBeNull();
      expect(calls).toHaveLength(0);
      expect(h.spawn).not.toHaveBeenCalled();
    },
  );
});

describe('runStep: model readiness', () => {
  it('returns "waking model" while /health answers 503, without claiming the job', async () => {
    on(/\/health$/, () => new Response('loading', { status: 503 }));
    const result = await runStep(await put({ state: 'ANALYZE', probe: PROBE, chunkCount: 2 }));
    expect(result).toEqual({ wait: WAKING });
    expect(await claimToken()).toBeNull();
    expect((await saved()).consecutiveFailures).toBe(0);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('treats a refused connection as loading', async () => {
    on(/\/health$/, () => Promise.reject(new TypeError('ECONNREFUSED')));
    expect(await runStep(await pickJob())).toEqual({ wait: WAKING });
  });

  it('returns "waiting on another run" when every slot is processing', async () => {
    on(/\/slots$/, () => json([{ is_processing: true }]));
    const result = await runStep(await pickJob());
    expect(result).toEqual({ wait: 'waiting on another run' });
    expect(await claimToken()).toBeNull();
    expect((await saved()).state).toBe('PICK');
  });

  it('skips the model check for steps that only run ffmpeg', async () => {
    on(/\/health$/, () => new Response('', { status: 503 }));
    await runStep(await put({ state: 'PREP' }));
    expect(called(/\/health$/)).toHaveLength(0);
    expect((await saved()).state).toBe('ANALYZE');
  });
});

describe('runStep: claims', () => {
  it('waits when another tab holds an unexpired claim', async () => {
    const job = await put({ state: 'PREP' });
    await db()
      .update(jobs)
      .set({ claimToken: 'other', claimUntil: sql`now() + interval '1 minute'` })
      .where(eq(jobs.id, 'j1'));
    const result = await runStep(job);
    expect(result).toEqual({ wait: 'step running in another tab' });
    expect((await saved()).state).toBe('PREP');
    expect(await claimToken()).toBe('other');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('takes over a lapsed claim', async () => {
    const job = await put({ state: 'PREP' });
    await db()
      .update(jobs)
      .set({ claimToken: 'old', claimUntil: sql`now() - interval '1 second'` })
      .where(eq(jobs.id, 'j1'));
    await runStep(job);
    expect((await saved()).state).toBe('ANALYZE');
    expect(await claimToken()).toBeNull();
  });
});

describe('runStep: PREP', () => {
  it('probes and measures the whole file through a signed URL, then starts ANALYZE', async () => {
    expect(await runStep(await put({ state: 'PREP', consecutiveFailures: 1, error: 'x' }))).toEqual(
      {},
    );
    const job = await saved();
    expect(job.state).toBe('ANALYZE');
    expect(job.probe).toEqual({ durationSec: 95, width: 1920, height: 1080, hasAudio: true });
    expect(job.measurements).toEqual({
      ...MEASURED,
      silences: [{ start: 80, end: 83 }],
    });
    expect(job.chunkCount).toBe(4);
    expect(job.chunkIndex).toBe(0);
    expect(job.contentType).toBe('video/quicktime');
    expect(job.consecutiveFailures).toBe(0);
    expect(job.error).toBeNull();
    expect(await claimToken()).toBeNull();
    const signed = 'https://storage.googleapis.com/bkt/uploads/j1?sig=read';
    for (const [, args] of h.spawn.mock.calls as [string, string[]][]) {
      expect(args).toContain(signed);
    }
    expect(h.spawn.mock.calls.map(([cmd]) => cmd)).toEqual(['ffprobe', 'ffmpeg']);
  });

  it('fails when the upload never reached storage', async () => {
    h.objects.clear();
    await runStep(await put({ state: 'PREP' }));
    expect(await saved()).toMatchObject({ state: 'FAILED', failedState: 'PREP' });
    expect((await saved()).error).toMatch(/never reached storage/);
  });

  it.each([Number.NaN, 0])('fails a video whose duration reads as %s', async (duration) => {
    tools.probe = { stdout: probeJson(duration) };
    await runStep(await put({ state: 'PREP' }));
    expect(await saved()).toMatchObject({ state: 'FAILED', failedState: 'PREP' });
    expect((await saved()).error).toMatch(/duration/);
  });

  it('fails a video with no audio track', async () => {
    tools.probe = { stdout: probeJson(60, false) };
    await runStep(await put({ state: 'PREP' }));
    expect(await saved()).toMatchObject({
      state: 'FAILED',
      failedState: 'PREP',
      error: 'This video has no audio track.',
    });
  });

  it(`lets anyone run up to ${MAX_MINUTES} minutes`, async () => {
    tools.probe = { stdout: probeJson(MAX_MINUTES * 60) };
    await runStep(await put({ state: 'PREP' }));
    expect((await saved()).state).toBe('ANALYZE');
    expect((await saved()).chunkCount).toBe(Math.ceil((900 - 1) / 29.5));
  });

  it(`refuses a video past ${MAX_MINUTES} minutes`, async () => {
    tools.probe = { stdout: probeJson(16 * 60) };
    await runStep(await put({ state: 'PREP', ...A_JOB }));
    expect((await saved()).state).toBe('FAILED');
    expect((await saved()).error).toBe('Videos are capped at 15 minutes; this one runs 16.0.');
  });

  it('counts an ffprobe crash as a failure without leaving PREP', async () => {
    tools.probe = { code: 1, stderr: 'Invalid data found' };
    await runStep(await put({ state: 'PREP' }));
    expect(await saved()).toMatchObject({ state: 'PREP', consecutiveFailures: 1 });
    expect((await saved()).error).toMatch(/ffprobe exited 1/);
  });
});

describe('runStep: ANALYZE', () => {
  it('stores no chunk when the job was discarded mid-analysis', async () => {
    const job = await put({ state: 'ANALYZE', probe: PROBE, chunkCount: 2, chunkIndex: 0 });
    on(/v1\/chat\/completions$/, async () => {
      await patchJob({ state: 'DISCARDED' });
      return completion(JSON.stringify(ANALYSIS));
    });
    await runStep(job);
    expect((await saved()).state).toBe('DISCARDED');
    expect(await chunkAt(0)).toBeUndefined();
  });

  it('saves the chunk and advances to the next window', async () => {
    const result = await runStep(
      await put({ state: 'ANALYZE', probe: PROBE, chunkCount: 2, chunkIndex: 0 }),
    );
    expect(result).toEqual({});
    expect(await saved()).toMatchObject({
      state: 'ANALYZE',
      chunkIndex: 1,
      consecutiveFailures: 0,
    });
    const chunk = (await chunkAt(0))!;
    expect(chunk).toMatchObject({ index: 0, startSec: 0, durationSec: 29.5, raw: null });
    expect(chunk.analysis).toEqual(ANALYSIS);
    const body = chatBodies()[0]!;
    expect(body.temperature).toBeCloseTo(0.2);
    expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
  });

  it('moves to PICK after the last chunk, cutting the short tail window', async () => {
    await runStep(await put({ state: 'ANALYZE', probe: PROBE, chunkCount: 2, chunkIndex: 1 }));
    expect(await saved()).toMatchObject({ state: 'PICK', chunkIndex: 2 });
    expect(await chunkAt(1)).toMatchObject({
      index: 1,
      startSec: 29.5,
      durationSec: 10.5,
    });
    const args = h.spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('-ss') + 1]).toBe('29.500');
    expect(args[args.indexOf('-t') + 1]).toBe('10.500');
  });

  /** Second window of three, with the first already analyzed. */
  const analyzing = async () => {
    const job = await put({ state: 'ANALYZE', probe: PROBE, chunkCount: 3, chunkIndex: 1 });
    await seed({ jobChunks: [{ jobId: 'j1', index: 0, data: { index: 0 } }] });
    return job;
  };

  it("stores an ffmpeg failure without the signed URL's signature", async () => {
    tools.window = {
      code: 1,
      stderr:
        'https://storage.googleapis.com/bkt/uploads/j1?X-Goog-Signature=abc123: 403 Forbidden',
    };
    await runStep(await analyzing());
    expect((await saved()).error).toMatch(/ffmpeg exited 1/);
    expect((await saved()).error).toContain('uploads/j1?[redacted]');
    expect((await saved()).error).not.toContain('X-Goog-Signature');
  });

  it('counts one thrown step, keeps the state, and fails on the second in a row', async () => {
    tools.window = { code: 1, stderr: 'boom\nmoov atom not found' };
    await runStep(await analyzing());
    expect(await saved()).toMatchObject({
      state: 'ANALYZE',
      chunkIndex: 1,
      consecutiveFailures: 1,
    });
    expect((await saved()).error).toMatch(/ffmpeg exited 1/);
    expect(await claimToken()).toBeNull();

    await runStep(await saved());
    expect(await saved()).toMatchObject({
      state: 'FAILED',
      failedState: 'ANALYZE',
      consecutiveFailures: 2,
      chunkIndex: 1,
    });
    expect(await chunkAt(0)).toBeDefined();
  });

  it('waits without a failure when the model scales to zero mid-step', async () => {
    on(
      /chat\/completions$/,
      () => new Response('Model is not yet ready for inference.', { status: 429 }),
    );
    const result = await runStep(await put({ state: 'ANALYZE', probe: PROBE, chunkCount: 2 }));
    expect(result).toEqual({ wait: WAKING });
    expect(await saved()).toMatchObject({
      state: 'ANALYZE',
      chunkIndex: 0,
      consecutiveFailures: 0,
      error: null,
    });
    expect(await chunkAt(0)).toBeUndefined();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('counts a quota 429 as a failure and reports it', async () => {
    on(/chat\/completions$/, () => new Response('Quota exceeded', { status: 429 }));
    const result = await runStep(await put({ state: 'ANALYZE', probe: PROBE, chunkCount: 2 }));
    expect(result).toEqual({});
    expect(await saved()).toMatchObject({ state: 'ANALYZE', consecutiveFailures: 1 });
    expect((await saved()).error).toBe('llama-server 429: Quota exceeded');
    expect(captureException).toHaveBeenCalledOnce();
  });

  it('resets the failure count after a step succeeds', async () => {
    await runStep(
      await put({ state: 'ANALYZE', probe: PROBE, chunkCount: 3, consecutiveFailures: 1 }),
    );
    expect(await saved()).toMatchObject({ consecutiveFailures: 0, error: null, chunkIndex: 1 });
  });

  it('keeps the raw reply when the model never returns valid JSON', async () => {
    on(/chat\/completions$/, () => completion('not json'));
    await runStep(await put({ state: 'ANALYZE', probe: PROBE, chunkCount: 2 }));
    expect(await chunkAt(0)).toMatchObject({ analysis: null, raw: 'not json' });
    expect((await saved()).chunkIndex).toBe(1);
  });
});

const chunkDoc = (index: number) => ({
  index,
  startSec: index * 29.5,
  durationSec: 29.5,
  measurements: MEASURED,
  analysis: ANALYSIS,
  raw: null,
  modelMs: 4000,
});

const context = () => {
  const body = chatBodies().at(-1)!;
  const messages = body.messages as { content: { type: string; text?: string }[] }[];
  return JSON.parse(messages[1]!.content[0]!.text!) as {
    artist: string | null;
    facts: { key: string }[];
    feedback: unknown[];
    skippedVersions?: { title: string }[];
    candidateHashtags: string[];
    candidateTags: { tag: string; usedBy: number }[];
    audienceTopVideos: unknown[];
    recentUploads?: unknown[];
    brandGuide?: unknown;
  };
};

/** The PICK step's job, with its two analyzed chunks; the chunks need the job row first. */
async function pickJob(patch: Partial<JobDoc> = {}): Promise<JobDoc> {
  const job = await put({ state: 'PICK', ...patch });
  await seed({
    jobChunks: [0, 1].map((index) => ({ jobId: 'j1', index, data: chunkDoc(index) })),
  });
  return job;
}

const NATHAN_FEEDBACK = {
  kind: 'EDITED',
  jobId: 'old',
  songTitle: 'Earlier',
  pickVersion: 1,
  field: 'title',
  before: 'A',
  after: 'B',
  at: 5,
};

describe('runStep: PICK', () => {
  it('stores candidates and pick version 1 for an unlinked job, with no artist identity', async () => {
    expect(await runStep(await pickJob({ measurements: MEASURED }))).toEqual({});
    const job = await saved();
    expect(job.state).toBe('REVIEW');
    expect(job.hashtagCandidates).toEqual([SYNTHWAVE, RETROWAVE, '#newmusic']);
    const pick = (await pickAt(1))!;
    expect(pick).toMatchObject({ version: 1, skipped: false });
    expect(typeof pick.modelMs).toBe('number');
    for (const tag of pick.hashtags as string[]) expect(job.hashtagCandidates).toContain(tag);

    const ctx = context();
    expect(ctx).not.toHaveProperty('artist');
    expect(ctx.facts).toEqual([]);
    expect(ctx.feedback).toEqual([]);
    expect(ctx.skippedVersions).toBeUndefined();
    expect(ctx.candidateTags.map((c) => c.tag)).not.toContain(ARTIST);
    expect(pick.tags).not.toContain(ARTIST);
    expect(await artistRowCount()).toBe(0);
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(1);
    expect(called(/playlistItems/)).toHaveLength(0);
    expect(ctx.recentUploads).toEqual([]);
    expect(job.audience).toMatchObject({ hashtags: job.hashtagCandidates });
  });

  it('records the pick request and the stored pick on the smart-pick agent span', async () => {
    clearAgentSpan();
    await runStep(await pickJob({ measurements: MEASURED }));
    const { input, output } = agentSpanIO();
    expect(input).toHaveLength(1);
    expect(input[0]!['gen_ai.input.messages']).toContain('recentUploads');
    const stored = (await pickAt(1))!;
    expect(JSON.parse(output[0]!)).toMatchObject({ title: stored.title });
  });

  it("compares Nathan's job against every recent FLR upload", async () => {
    await runStep(await pickJob(A_JOB));
    expect(context().artist).toBe(ARTIST);
    const catalog = called(/com\/youtube\/v3\/videos\?/).map((c) =>
      new URL(c.url).searchParams.get('id'),
    );
    expect(catalog[0]).toBe('v1,v2,v3,v4,v5,v6');
    // Only the three newest uploads go to the model, each with its thumbnail.
    expect(context().recentUploads).toHaveLength(3);
    expect(called(/i\.ytimg\.com/)).toHaveLength(3);
    expect(new URL(called(/youtube\/v3\/channels\?/)[0]!.url).searchParams.get('id')).toBe('UCflr');
  });
});

describe("runStep: PICK with Nathan's memory", () => {
  it("keeps Nathan's memory out of an unlinked job and writes none of it", async () => {
    await seed({ artistFeedback: [{ artistId: 'flr', at: new Date(5), data: NATHAN_FEEDBACK }] });
    await runStep(await pickJob());
    expect((await saved()).state).toBe('REVIEW');
    const ctx = context();
    expect(ctx.feedback).toEqual([]);
    expect(ctx.facts).toEqual([]);
    expect(await artistRowCount()).toBe(1);
  });

  it("treats Nathan's job as unlinked once its owner's link is removed", async () => {
    await seed({ artistFeedback: [{ artistId: 'flr', at: new Date(5), data: NATHAN_FEEDBACK }] });
    await approveGuide();
    await unlinkA();
    await runStep(await pickJob(A_JOB));
    expect((await saved()).state).toBe('REVIEW');
    const ctx = context();
    expect(ctx).not.toHaveProperty('artist');
    expect(ctx).not.toHaveProperty('brandGuide');
    expect([ctx.facts, ctx.feedback, ctx.recentUploads]).toEqual([[], [], []]);
    expect(called(/playlistItems/)).toHaveLength(0);
    // Nothing was read into the prompt and nothing was seeded.
    expect(await artistRowCount()).toBe(2);
  });

  it("uses Nathan's facts, feedback, cached candidates, and skipped versions", async () => {
    await seed({ artistFeedback: [{ artistId: 'flr', at: new Date(5), data: NATHAN_FEEDBACK }] });
    const job = await pickJob({
      ...A_JOB,
      hashtagCandidates: [SYNTHWAVE, RETROWAVE, '#newmusic'],
      audience: {
        query: 'synthwave music video',
        hashtags: [SYNTHWAVE, RETROWAVE, '#newmusic'],
        tags: [
          { tag: 'synthwave', usedBy: 9 },
          { tag: 'outrun', usedBy: 4 },
        ],
        top: [{ title: 'Top', description: 'd', tags: ['outrun'], views: 9 }],
      },
    });
    await seed({
      jobPicks: [
        {
          jobId: 'j1',
          version: 1,
          data: {
            ...RAW_PICK,
            title: 'Old Title',
            description: 'An older description.',
            version: 1,
            skipped: true,
          },
        },
        {
          jobId: 'j1',
          version: 2,
          data: { ...RAW_PICK, title: 'Second', version: 2, skipped: false, modelMs: 50_000 },
        },
      ],
    });
    await runStep(job);
    expect((await saved()).state).toBe('REVIEW');
    const third = (await pickAt(3)) as { version: number; modelMs: number };
    expect(third.version).toBe(3);
    // The stored time carries the earlier runs, so a re-run never drops them from the total.
    expect(third.modelMs).toBeGreaterThanOrEqual(50_000);
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(0);
    const ctx = context();
    expect(ctx.artist).toBe(ARTIST);
    expect(ctx.candidateTags).toEqual([
      { tag: 'synthwave', usedBy: 9 },
      { tag: 'outrun', usedBy: 4 },
      { tag: ARTIST, usedBy: 0 },
    ]);
    expect(ctx.audienceTopVideos).toEqual([
      { title: 'Top', description: 'd', tags: ['outrun'], views: 9 },
    ]);
    // The private INFERENCE is read but never reaches the prompt.
    expect(ctx.facts.map((f) => f.key)).toEqual([ARTIST_NAME_KEY, 'home']);
    expect(ctx.feedback).toHaveLength(1);
    expect(ctx.skippedVersions).toEqual([
      { title: 'Old Title', description: 'An older description.' },
    ]);
    expect((await db().select().from(artistFacts)).some((r) => r.key === 'home')).toBe(true);
  });

  const GUIDE = { statement: 'Plain titles.', keep: ['Song only'], fix: [], drop: ['Emoji'] };
  const approveGuide = () =>
    seed({
      artistBrand: [
        {
          artistId: 'flr',
          slot: 'approved',
          data: { ...GUIDE, status: 'APPROVED', basedOn: ['v1'], createdAt: 1, approvedAt: 2 },
        },
      ],
    });

  it("follows Nathan's approved brand guide", async () => {
    await approveGuide();
    await runStep(await pickJob(A_JOB));
    expect(context().brandGuide).toEqual(GUIDE);
  });

  it('keeps the brand guide out of unlinked jobs', async () => {
    await approveGuide();
    await runStep(await pickJob());
    expect(context()).not.toHaveProperty('brandGuide');
  });

  it('counts an unparseable recommendation as a failure', async () => {
    on(/chat\/completions$/, () => completion(BAD_PICK_JSON));
    await runStep(await pickJob());
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
    expect((await saved()).error).toBe('The model reply did not parse as a recommendation.');
    expect(await pickAt(1)).toBeUndefined();
  });

  it('reports the original model error to Sentry, not the evidence-carrying wrapper', async () => {
    captureException.mockClear();
    on(/chat\/completions$/, () => completion(BAD_PICK_JSON));
    await runStep(await pickJob());
    expect(captureException).toHaveBeenCalledTimes(1);
    const [reported, context] = captureException.mock.calls[0]!;
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).constructor.name).toBe('Error');
    expect((reported as Error).message).toBe('The model reply did not parse as a recommendation.');
    expect(context).toEqual({ tags: { step: 'PICK' } });
  });

  it('keeps the genre search when the model fails, so the retry does not search again', async () => {
    on(/chat\/completions$/, () => completion(BAD_PICK_JSON));
    await runStep(await pickJob());
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(1);
    expect((await saved()).audience).toMatchObject({
      hashtags: [SYNTHWAVE, RETROWAVE, '#newmusic'],
    });

    on(/chat\/completions$/, () => completion(JSON.stringify(RAW_PICK)));
    await runStep(await saved());
    expect(await saved()).toMatchObject({ state: 'REVIEW', consecutiveFailures: 0 });
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(1);
  });

  it('keeps the genre search and waits when the model scales to zero mid-pick', async () => {
    on(
      /chat\/completions$/,
      () => new Response('Model is not yet ready for inference.', { status: 429 }),
    );
    expect(await runStep(await pickJob())).toEqual({ wait: WAKING });
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 0, error: null });
    expect((await saved()).audience).toMatchObject({
      hashtags: [SYNTHWAVE, RETROWAVE, '#newmusic'],
    });
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('runStep: PUBLISHING', () => {
  const DESTINATION = { channelId: CHANNEL_A, channelTitle: 'Flies Like Robots' };
  const publishing = (patch: Partial<JobDoc> = {}) =>
    put({
      state: 'PUBLISHING',
      ...A_JOB,
      destination: DESTINATION,
      finalFields: FIELDS,
      ...patch,
    });

  it('fails when there is nothing to upload', async () => {
    await runStep(await publishing({ finalFields: null }));
    expect(await saved()).toMatchObject({ state: 'FAILED', failedState: 'PUBLISHING' });
  });

  it('fails when no destination was pinned', async () => {
    await runStep(await publishing({ destination: null }));
    expect(await saved()).toMatchObject({ state: 'FAILED', error: 'Nothing to upload.' });
  });

  it('waits to reconnect when the grant is revoked, without calling YouTube', async () => {
    await revokeA();
    expect(await runStep(await publishing())).toEqual({ wait: RECONNECT });
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      consecutiveFailures: 0,
      error: null,
      uploadStartedAt: null,
    });
    expect(called(/upload\/youtube/)).toHaveLength(0);
  });

  it.each<[string, () => Promise<unknown>, Partial<JobDoc>, string]>([
    ['reconnect', revokeA, {}, RECONNECT],
    ['an unknown outcome', async () => {}, { finalChunkAt: 5 }, OUTCOME_UNKNOWN],
    ['a spent limit', async () => {}, { limitUntil: Date.now() + 60_000 }, DAILY_LIMIT],
    [
      'reconnect while verifying',
      revokeA,
      { state: 'CLAIMED_COMPLETE', videoId: 'vid1' },
      RECONNECT,
    ],
  ])(
    'a %s wait ends the failure streak and clears a stale error',
    async (_l, arrange, patch, wait) => {
      await arrange();
      const job = await publishing({ consecutiveFailures: 1, error: 'stale', ...patch });
      expect(await runStep(job)).toEqual({ wait });
      expect(await saved()).toMatchObject({ consecutiveFailures: 0, error: null });
    },
  );

  it('records a failure when the grant is on another channel, without calling YouTube', async () => {
    await db()
      .update(connections)
      .set({ channelId: 'UCother' })
      .where(eq(connections.uid, A_JOB.ownerUid));
    expect(await runStep(await publishing())).toEqual({});
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      consecutiveFailures: 1,
      error: "Connected channel doesn't match this job's channel.",
      uploadStartedAt: null,
    });
    expect(called(/upload\/youtube/)).toHaveLength(0);
  });

  it('records a failure when the grant refresh errors, keeping the connection', async () => {
    h.refreshError = new Error('ECONNRESET');
    expect(await runStep(await publishing())).toEqual({});
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      consecutiveFailures: 1,
      error: "Couldn't refresh the YouTube grant.",
      uploadStartedAt: null,
    });
    const [connection] = await db()
      .select()
      .from(connections)
      .where(eq(connections.uid, A_JOB.ownerUid));
    expect(connection).toMatchObject({ status: 'connected', channelId: CHANNEL_A });
    expect(called(/upload\/youtube/)).toHaveLength(0);
  });

  it('waits to reconnect when the connection row is gone', async () => {
    await db().delete(connections).where(eq(connections.uid, A_JOB.ownerUid));
    expect(await runStep(await publishing())).toEqual({ wait: RECONNECT });
  });

  it("never uploads with another user's grant", async () => {
    expect(await runStep(await publishing({ ownerUid: 'uid-b', artistId: null }))).toEqual({
      wait: RECONNECT,
    });
    expect(called(/upload\/youtube/)).toHaveLength(0);
  });

  it('stops a live session mid-upload once the grant is revoked, keeping its progress', async () => {
    await revokeA();
    const upload = { sessionUri: SESSION_URI, total: 1000 };
    const progress = { sent: 400, total: 1000 };
    await runStep(await publishing({ upload, uploadProgress: progress, uploadStartedAt: 7 }));
    // The session URI alone would authorize the PUT; the grant check is what stops it.
    expect(called(/upload\.example/)).toHaveLength(0);
    expect(await saved()).toMatchObject({ upload, uploadProgress: progress, uploadStartedAt: 7 });
  });

  it('marks the upload started before the initiation request goes out', async () => {
    let markedAtRequest: number | null = null;
    on(/upload\/youtube\/v3\/videos/, async () => {
      markedAtRequest = (await saved()).uploadStartedAt;
      return new Response('forbidden', { status: 403 });
    });
    await runStep(await publishing());
    expect(markedAtRequest).toEqual(expect.any(Number));
    // A failed initiation may still have opened a session; the marker stays.
    expect((await saved()).uploadStartedAt).toBe(markedAtRequest);
  });

  it('keeps the first upload start through a session reset, a retry and a reconnect', async () => {
    await runStep(await publishing({ uploadStartedAt: 7 }));
    expect((await saved()).uploadStartedAt).toBe(7);

    on(/upload\.example\/s1/, () => new Response('gone', { status: 404 }));
    await runStep(await saved());
    expect(await saved()).toMatchObject({ upload: null, uploadStartedAt: 7 });

    await patchJob({ state: 'FAILED', failedState: 'PUBLISHING' });
    await retry(await saved());
    expect(await saved()).toMatchObject({ state: 'PUBLISHING', uploadStartedAt: 7 });

    await revokeA();
    expect(await runStep(await saved())).toEqual({ wait: RECONNECT });
    await db()
      .update(connections)
      .set({ status: 'connected', tokenCiphertext: USERS.connections[0]!.tokenCiphertext })
      .where(eq(connections.uid, USER_A.uid));
    await runStep(await saved());
    expect(await saved()).toMatchObject({
      upload: { sessionUri: SESSION_URI },
      uploadStartedAt: 7,
    });
  });

  it('opens a private resumable upload sized from storage', async () => {
    await runStep(await publishing());
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      upload: { sessionUri: SESSION_URI, total: 1000 },
      uploadProgress: { sent: 0, total: 1000 },
    });
    const init = called(/upload\/youtube\/v3\/videos/)[0]!.init;
    expect(headers(init)['x-upload-content-length']).toBe('1000');
    expect(headers(init).authorization).toBe(A_TOKEN);
    expect(JSON.parse(String(init.body)).status).toEqual({
      privacyStatus: 'private',
      selfDeclaredMadeForKids: false,
    });
  });

  it('fails when the source expired from storage', async () => {
    h.objects.clear();
    await runStep(await publishing());
    expect(await saved()).toMatchObject({ state: 'FAILED', failedState: 'PUBLISHING' });
  });

  it.each([
    ['the project quota', 403, 'quotaExceeded'],
    ["the channel's upload limit", 400, 'uploadLimitExceeded'],
  ])('waits without a failure when %s is spent at initiation', async (_label, status, reason) => {
    on(
      /upload\/youtube\/v3\/videos/,
      () => new Response(`{"error":{"errors":[{"reason":"${reason}"}]}}`, { status }),
    );
    expect(await runStep(await publishing({ consecutiveFailures: 1, error: 'stale' }))).toEqual({
      wait: DAILY_LIMIT,
    });
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      consecutiveFailures: 0,
      error: null,
      upload: null,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('holds the wait until the Pacific midnight reset, with no grant refresh or YouTube call', async () => {
    on(/upload\/youtube\/v3\/videos/, () => new Response('quotaExceeded', { status: 403 }));
    vi.setSystemTime(NOON_PACIFIC);
    await runStep(await publishing());
    const { limitUntil } = await saved();
    expect(limitUntil).toBe(quotaResetAt(NOON_PACIFIC));
    calls.length = 0;
    h.refreshError = new Error('a refresh would fail the step');
    for (let i = 0; i < 2; i++) {
      expect(await runStep(await saved())).toEqual({ wait: DAILY_LIMIT });
    }
    expect(calls).toHaveLength(0);
    expect(await saved()).toMatchObject({ consecutiveFailures: 0, limitUntil });
  });

  it('calls YouTube again once the limit has reset, clearing it on success', async () => {
    expect(await runStep(await publishing({ limitUntil: Date.now() - 1 }))).toEqual({});
    expect(await saved()).toMatchObject({
      upload: { sessionUri: SESSION_URI },
      limitUntil: null,
    });
  });

  it('sets a fresh reset when the limit is still spent after the last one passed', async () => {
    on(/upload\/youtube\/v3\/videos/, () => new Response('quotaExceeded', { status: 403 }));
    vi.setSystemTime(NOON_PACIFIC);
    await runStep(await publishing({ limitUntil: 1 }));
    expect((await saved()).limitUntil).toBe(quotaResetAt(NOON_PACIFIC));
  });

  it.each([
    [400, 'uploadLimitExceeded'],
    [403, 'quotaExceeded'],
  ])(
    'waits without a failure when a chunk gets %i %s, keeping the session',
    async (status, reason) => {
      const upload = { sessionUri: SESSION_URI, total: 1000 };
      on(/upload\.example\/s1/, (_url, init) =>
        headers(init)['content-range'] === 'bytes */1000'
          ? new Response('', { status: 308, headers: { range: 'bytes=0-399' } })
          : new Response(`{"error":{"errors":[{"reason":"${reason}"}]}}`, { status }),
      );
      expect(await runStep(await publishing({ upload }))).toEqual({ wait: DAILY_LIMIT });
      expect(await saved()).toMatchObject({
        state: 'PUBLISHING',
        consecutiveFailures: 0,
        upload,
        limitUntil: expect.any(Number),
      });
      expect(captureException).not.toHaveBeenCalled();
    },
  );

  it('counts a 401 as lost access, not an unknown outcome, revoking the grant', async () => {
    on(/upload\/youtube\/v3\/videos/, () => new Response('unauthorized', { status: 401 }));
    expect(await runStep(await publishing())).toEqual({ wait: RECONNECT });
    expect(await saved()).toMatchObject({ state: 'PUBLISHING', consecutiveFailures: 0 });
    const [connection] = await db()
      .select()
      .from(connections)
      .where(eq(connections.uid, A_JOB.ownerUid));
    expect(connection).toMatchObject({ status: 'revoked', tokenCiphertext: null });
    expect(captureMessage).toHaveBeenCalledWith('YouTube refused the grant', {
      level: 'warning',
      tags: { 'job.id': 'j1' },
    });
  });

  it('counts a 401 on the final chunk as lost access, keeping the session', async () => {
    const upload = { sessionUri: SESSION_URI, total: 1000 };
    on(/upload\.example\/s1/, (_url, init) =>
      headers(init)['content-range'] === 'bytes */1000'
        ? new Response('', { status: 308 })
        : new Response('unauthorized', { status: 401 }),
    );
    expect(await runStep(await publishing({ upload }))).toEqual({ wait: RECONNECT });
    expect(await saved()).toMatchObject({ upload, videoId: null });
  });

  it('counts other upload-init errors as step failures', async () => {
    on(/upload\/youtube\/v3\/videos/, () => new Response('forbidden', { status: 403 }));
    await runStep(await publishing());
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      consecutiveFailures: 1,
      upload: null,
    });
  });

  it('streams the next range from GCS and records progress on a 308', async () => {
    on(/upload\.example\/s1/, (_url, init) =>
      headers(init)['content-range'] === 'bytes */1000'
        ? new Response('', { status: 308, headers: { range: 'bytes=0-399' } })
        : new Response('', { status: 308, headers: { range: 'bytes=0-699' } }),
    );
    await runStep(await publishing({ upload: { sessionUri: SESSION_URI, total: 1000 } }));
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      uploadProgress: { sent: 700, total: 1000 },
    });
    const source = called(/storage\.googleapis\.com/)[0]!;
    expect(source.url).toContain('sig=read');
    expect(headers(source.init).range).toBe('bytes=400-999');
    const put = called(/upload\.example\/s1/)[1]!;
    expect(headers(put.init)['content-range']).toBe('bytes 400-999/1000');
  });

  it('claims completion with the video ID on the final 200', async () => {
    await runStep(await publishing({ upload: { sessionUri: SESSION_URI, total: 1000 } }));
    expect(await saved()).toMatchObject({
      state: 'CLAIMED_COMPLETE',
      videoId: 'vid1',
      uploadProgress: { sent: 1000, total: 1000 },
    });
  });

  it('drops an expired upload session so the next step opens a fresh one', async () => {
    on(/upload\.example\/s1/, () => new Response('gone', { status: 404 }));
    await runStep(await publishing({ upload: { sessionUri: SESSION_URI, total: 1000 } }));
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      upload: null,
      uploadProgress: null,
    });
  });

  it('fails plainly when the source expired from storage mid-upload, sending nothing', async () => {
    on(/storage\.googleapis\.com/, () => new Response('gone', { status: 404 }));
    await runStep(await publishing({ upload: { sessionUri: SESSION_URI, total: 1000 } }));
    expect(await saved()).toMatchObject({
      state: 'FAILED',
      failedState: 'PUBLISHING',
      error: 'The source video has expired from storage.',
      finalChunkAt: null,
    });
    expect(called(/upload\.example\/s1/)).toHaveLength(1);
  });

  it('keeps the session and counts a failure when the range read errors otherwise', async () => {
    on(/upload\.example\/s1/, () => new Response('oops', { status: 500 }));
    await runStep(await publishing({ upload: { sessionUri: SESSION_URI, total: 1000 } }));
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      consecutiveFailures: 1,
      upload: { sessionUri: SESSION_URI, total: 1000 },
    });
  });

  it('skips the range read when YouTube already holds every byte', async () => {
    on(/upload\.example\/s1/, () => json({ id: 'vid2' }));
    await runStep(await publishing({ upload: { sessionUri: SESSION_URI, total: 1000 } }));
    expect(await saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', videoId: 'vid2' });
    expect(called(/storage\.googleapis\.com/)).toHaveLength(0);
  });
});

describe('runStep: PUBLISHING recovery', () => {
  const DESTINATION = { channelId: CHANNEL_A, channelTitle: 'Flies Like Robots' };
  const UPLOAD = { sessionUri: SESSION_URI, total: 1000 };
  const publishing = (patch: Partial<JobDoc> = {}) =>
    put({
      state: 'PUBLISHING',
      ...A_JOB,
      destination: DESTINATION,
      finalFields: FIELDS,
      ...patch,
    });
  const sessionGone = () => on(/upload\.example\/s1/, () => new Response('gone', { status: 404 }));
  const reconnectA = () =>
    db()
      .update(connections)
      .set({ status: 'connected', tokenCiphertext: USERS.connections[0]!.tokenCiphertext })
      .where(eq(connections.uid, USER_A.uid));
  const initiations = () => called(/upload\/youtube\/v3\/videos/);

  it('marks the final chunk before sending it', async () => {
    let markedAtPut: number | null = null;
    on(/upload\.example\/s1/, async (_url, init) => {
      if (headers(init)['content-range'] === 'bytes */1000')
        return new Response('', { status: 308, headers: { range: 'bytes=0-399' } });
      markedAtPut = (await saved()).finalChunkAt;
      return json({ id: 'vid1' });
    });
    await runStep(await publishing({ upload: UPLOAD }));
    expect(markedAtPut).toEqual(expect.any(Number));
    expect(await saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', finalChunkAt: markedAtPut });
  });

  it.each<[string, () => Response]>([
    ['errors', () => new Response('oops', { status: 503 })],
    [
      'times out',
      () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    ],
  ])('leaves the marker unset when the final range read %s', async (_label, reply) => {
    on(/storage\.googleapis\.com/, reply);
    await runStep(await publishing({ upload: UPLOAD }));
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      finalChunkAt: null,
      upload: UPLOAD,
      consecutiveFailures: 1,
    });
  });

  it('cancels the open source read and sends nothing when the marker cannot be written', async () => {
    let cancelled = false;
    on(
      /storage\.googleapis\.com/,
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 206 },
        ),
    );
    on(/upload\.example\/s1/, () => new Response('', { status: 308 }));
    await db().execute(sql`
      create function refuse_marker() returns trigger language plpgsql
        as $$ begin raise exception 'marker refused'; end $$
    `);
    await db().execute(sql`
      create trigger refuse_marker before update on jobs for each row
        when (new.final_chunk_at is distinct from old.final_chunk_at)
        execute function refuse_marker()
    `);
    try {
      await runStep(await publishing({ upload: UPLOAD }));
    } finally {
      await db().execute(sql`drop trigger refuse_marker on jobs`);
      await db().execute(sql`drop function refuse_marker`);
    }
    expect(cancelled).toBe(true);
    expect(called(/upload\.example\/s1/)).toHaveLength(1);
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      finalChunkAt: null,
      upload: UPLOAD,
      consecutiveFailures: 1,
    });
  });

  it('reports a failed cancel and still records the marker error', async () => {
    const cancelError = new Error('cancel broke');
    on(
      /storage\.googleapis\.com/,
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw cancelError;
            },
          }),
          { status: 206 },
        ),
    );
    on(/upload\.example\/s1/, () => new Response('', { status: 308 }));
    await db().execute(sql`
      create function refuse_marker() returns trigger language plpgsql
        as $$ begin raise exception 'marker refused'; end $$
    `);
    await db().execute(sql`
      create trigger refuse_marker before update on jobs for each row
        when (new.final_chunk_at is distinct from old.final_chunk_at)
        execute function refuse_marker()
    `);
    try {
      await runStep(await publishing({ upload: UPLOAD }));
    } finally {
      await db().execute(sql`drop trigger refuse_marker on jobs`);
      await db().execute(sql`drop function refuse_marker`);
    }
    expect(captureException).toHaveBeenCalledWith(cancelError, {
      tags: { 'job.id': 'j1', component: 'gcs-cancel' },
    });
    const [stepError] = captureException.mock.calls.find(([, context]) =>
      Boolean((context as { tags?: { step?: string } }).tags?.step),
    )!;
    expect(stepError).not.toBe(cancelError);
    // Drizzle wraps the driver error; the trigger's message is on its cause.
    expect(String((stepError as Error).cause)).toMatch(/marker refused/);
    expect(called(/upload\.example\/s1/)).toHaveLength(1);
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      finalChunkAt: null,
      consecutiveFailures: 1,
    });
  });

  it('leaves the marker unset while chunks before the last go out', async () => {
    h.objects.set('uploads/j1', { size: String(300 * 1024 * 1024), contentType: 'video/mp4' });
    const total = 300 * 1024 * 1024;
    on(
      /upload\.example\/s1/,
      () => new Response('', { status: 308, headers: { range: 'bytes=0-9' } }),
    );
    await runStep(await publishing({ upload: { sessionUri: SESSION_URI, total } }));
    expect(await saved()).toMatchObject({
      finalChunkAt: null,
      uploadProgress: { sent: 10, total },
    });
  });

  it('keeps the first marker when the final chunk is sent again', async () => {
    on(/upload\.example\/s1/, (_url, init) =>
      headers(init)['content-range'] === 'bytes */1000'
        ? new Response('', { status: 308 })
        : new Response('oops', { status: 500 }),
    );
    await runStep(await publishing({ upload: UPLOAD, finalChunkAt: 5 }));
    expect(await saved()).toMatchObject({
      finalChunkAt: 5,
      upload: UPLOAD,
      consecutiveFailures: 1,
    });
  });

  it('starts a fresh session on the same destination when the final chunk never went out', async () => {
    sessionGone();
    await runStep(await publishing({ upload: UPLOAD, uploadStartedAt: 7 }));
    expect(await saved()).toMatchObject({ upload: null, finalChunkAt: null });
    expect(captureMessage).toHaveBeenCalledWith('Upload session lost; restarting', {
      level: 'info',
      tags: { 'job.id': 'j1' },
    });
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain(SESSION_URI);
    handlers.shift();
    await runStep(await saved());
    expect(await saved()).toMatchObject({
      upload: { sessionUri: SESSION_URI },
      destination: DESTINATION,
      uploadStartedAt: 7,
    });
    expect(initiations()).toHaveLength(1);
  });

  it('pauses with the outcome unknown when the session is lost after the final chunk', async () => {
    sessionGone();
    expect(await runStep(await publishing({ upload: UPLOAD, finalChunkAt: 5 }))).toEqual({
      wait: OUTCOME_UNKNOWN,
    });
    const job = await saved();
    expect(job).toMatchObject({
      state: 'PUBLISHING',
      upload: null,
      videoId: null,
      finalChunkAt: 5,
    });
    expect(job.consecutiveFailures).toBe(0);
    expect(outcomeUnknown(job)).toBe(true);
    expect(captureMessage).toHaveBeenCalledWith('Upload session lost after final chunk', {
      level: 'warning',
      tags: { 'job.id': 'j1' },
    });
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain(SESSION_URI);
  });

  it('pauses when the final chunk PUT itself finds the session gone', async () => {
    on(/upload\.example\/s1/, (_url, init) =>
      headers(init)['content-range'] === 'bytes */1000'
        ? new Response('', { status: 308 })
        : new Response('gone', { status: 404 }),
    );
    expect(await runStep(await publishing({ upload: UPLOAD }))).toEqual({ wait: OUTCOME_UNKNOWN });
    expect(outcomeUnknown(await saved())).toBe(true);
  });

  it('makes no YouTube call when the paused job has no upload key at all', async () => {
    await publishing({ finalChunkAt: 5 });
    await db()
      .update(jobs)
      .set({ data: sql`${jobs.data} - 'upload'` })
      .where(eq(jobs.id, 'j1'));
    expect(await runStep(await saved())).toEqual({ wait: OUTCOME_UNKNOWN });
    expect(calls).toHaveLength(0);
  });

  it('makes no YouTube call while the outcome is unknown, on any later step', async () => {
    await publishing({ finalChunkAt: 5 });
    for (let i = 0; i < 3; i++) {
      expect(await runStep(await saved())).toEqual({ wait: OUTCOME_UNKNOWN });
    }
    expect(calls).toHaveLength(0);
    expect(await saved()).toMatchObject({ state: 'PUBLISHING', upload: null });
  });

  const failedAfterFinal = () =>
    publishing({ upload: UPLOAD, finalChunkAt: 5, state: 'FAILED', failedState: 'PUBLISHING' });

  it('asks the live session after a retry that follows the final chunk, completing it', async () => {
    on(/upload\.example\/s1/, () => json({ id: 'vid3' }));
    await failedAfterFinal();
    await retry(await saved());
    expect(await saved()).toMatchObject({ state: 'PUBLISHING', upload: UPLOAD });
    expect(await runStep(await saved())).toEqual({});
    expect(await saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', videoId: 'vid3' });
    expect(initiations()).toHaveLength(0);
  });

  it('never restarts after a retry when the session is gone after the final chunk', async () => {
    sessionGone();
    await failedAfterFinal();
    await retry(await saved());
    expect(await runStep(await saved())).toEqual({ wait: OUTCOME_UNKNOWN });
    expect(await runStep(await saved())).toEqual({ wait: OUTCOME_UNKNOWN });
    expect(initiations()).toHaveLength(0);
  });

  it('resumes from the offset YouTube holds after a reconnect, with no second upload', async () => {
    await revokeA();
    on(/upload\.example\/s1/, (_url, init) =>
      headers(init)['content-range'] === 'bytes */1000'
        ? new Response('', { status: 308, headers: { range: 'bytes=0-599' } })
        : json({ id: 'vid1' }),
    );
    const job = await publishing({ upload: UPLOAD, uploadProgress: { sent: 600, total: 1000 } });
    expect(await runStep(job)).toEqual({ wait: RECONNECT });
    await reconnectA();
    await runStep(await saved());
    expect(headers(called(/storage\.googleapis\.com/)[0]!.init).range).toBe('bytes=600-999');
    expect(await saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', videoId: 'vid1' });
    expect(initiations()).toHaveLength(0);
  });

  it('keeps the video ID and verifies when the status check finds the upload complete', async () => {
    on(/upload\.example\/s1/, () => json({ id: 'vid9' }));
    await runStep(await publishing({ upload: UPLOAD, finalChunkAt: 5 }));
    expect(await saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', videoId: 'vid9' });
    await runStep(await saved());
    expect(await saved()).toMatchObject({ state: 'VERIFIED', videoId: 'vid9' });
    expect(called(/storage\.googleapis\.com/)).toHaveLength(0);
  });

  it('resumes before initiation after a reconnect, opening exactly one session', async () => {
    await revokeA();
    expect(await runStep(await publishing())).toEqual({ wait: RECONNECT });
    await reconnectA();
    await runStep(await saved());
    expect(initiations()).toHaveLength(1);
    expect(JSON.parse(String(initiations()[0]!.init.body)).snippet.title).toBe(FIELDS.title);
    expect(await saved()).toMatchObject({ destination: DESTINATION, finalFields: FIELDS });
  });

  it('resumes from the offset after a lost final response, with no second upload', async () => {
    on(/upload\.example\/s1/, (_url, init) =>
      headers(init)['content-range'] === 'bytes */1000'
        ? new Response('', { status: 308, headers: { range: 'bytes=0-599' } })
        : json({ id: 'vid1' }),
    );
    await runStep(await publishing({ upload: UPLOAD, finalChunkAt: 5 }));
    expect(headers(called(/storage\.googleapis\.com/)[0]!.init).range).toBe('bytes=600-999');
    expect(await saved()).toMatchObject({
      state: 'CLAIMED_COMPLETE',
      videoId: 'vid1',
      finalChunkAt: 5,
    });
    expect(initiations()).toHaveLength(0);
  });

  it('keeps the video ID when the job is discarded during the final chunk', async () => {
    on(/upload\.example\/s1/, async (_url, init) => {
      if (headers(init)['content-range'] === 'bytes */1000')
        return new Response('', { status: 308, headers: { range: 'bytes=0-399' } });
      await patchJob({ state: 'DISCARDED' });
      return json({ id: 'vid1' });
    });
    expect(await runStep(await publishing({ upload: UPLOAD }))).toEqual({});
    expect(await saved()).toMatchObject({ state: 'DISCARDED', videoId: 'vid1' });
    expect(await claimToken()).toBeNull();
  });

  it('resumes verification after a reconnect, without uploading', async () => {
    await revokeA();
    await publishing({ state: 'CLAIMED_COMPLETE', videoId: 'vid1', uploadStartedAt: 7 });
    expect(await runStep(await saved())).toEqual({ wait: RECONNECT });
    await reconnectA();
    await runStep(await saved());
    expect(await saved()).toMatchObject({ state: 'VERIFIED', videoId: 'vid1' });
    expect(initiations()).toHaveLength(0);
    expect(called(/upload\.example/)).toHaveLength(0);
  });
});

describe('runStep: CLAIMED_COMPLETE', () => {
  const claimed = (patch: Partial<JobDoc> = {}) =>
    put({
      state: 'CLAIMED_COMPLETE',
      ...A_JOB,
      destination: { channelId: CHANNEL_A, channelTitle: 'Flies Like Robots' },
      videoId: 'vid1',
      finalFields: FIELDS,
      ...patch,
    });
  const publishes = () => db().select().from(artistPublishes);

  it('marks VERIFIED on read-back and records the publish for Nathan', async () => {
    expect(await runStep(await claimed())).toEqual({});
    expect((await saved()).state).toBe('VERIFIED');
    expect((await publishes())[0]!.data).toMatchObject({
      videoId: 'vid1',
      url: 'https://youtu.be/vid1',
      jobId: 'j1',
      fields: FIELDS,
      status: 'VERIFIED',
    });
    expect(headers(called(/com\/youtube\/v3\/videos\?/)[0]!.init).authorization).toBe(A_TOKEN);
  });

  it("verifies a job outside Nathan's artist without touching the artist tables", async () => {
    await runStep(await claimed({ artistId: null }));
    expect((await saved()).state).toBe('VERIFIED');
    expect(await artistRowCount()).toBe(0);
  });

  it("records no publish once Nathan's job owner is unlinked", async () => {
    await unlinkA();
    await runStep(await claimed());
    expect((await saved()).state).toBe('VERIFIED');
    expect(await artistRowCount()).toBe(0);
  });

  it('fails when YouTube rejected the upload', async () => {
    on(/com\/youtube\/v3\/videos\?/, () =>
      json({ items: [{ id: 'vid1', status: { uploadStatus: 'rejected' } }] }),
    );
    await runStep(await claimed());
    expect(await saved()).toMatchObject({ state: 'FAILED', error: 'YouTube rejected the upload.' });
    expect(await publishes()).toEqual([]);
  });

  it('counts an attempt without a report while a listed upload has no status', async () => {
    on(/com\/youtube\/v3\/videos\?/, () => json({ items: [{ id: 'vid1', status: {} }] }));
    expect(await runStep(await claimed())).toEqual({ wait: WAITING_ON_YOUTUBE });
    expect(await saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', verifyAttempts: 1 });
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('reports an unknown upload status and keeps waiting', async () => {
    on(/com\/youtube\/v3\/videos\?/, () =>
      json({ items: [{ id: 'vid1', status: { uploadStatus: 'quarantined' } }] }),
    );
    expect(await runStep(await claimed())).toEqual({ wait: WAITING_ON_YOUTUBE });
    expect(await saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', verifyAttempts: 1 });
    expect(captureMessage).toHaveBeenCalledExactlyOnceWith('Unknown YouTube uploadStatus', {
      level: 'warning',
      tags: { 'job.id': 'j1', uploadStatus: 'quarantined' },
    });
  });

  it.each([
    [{ uploadStatus: 'quarantined' }, 'YouTube kept the upload at "quarantined".'],
    [{}, 'YouTube never gave the upload a status.'],
  ])(
    `fails on the status YouTube kept, or its absence, after ${VERIFY_ATTEMPTS} read-backs of %o`,
    async (status, error) => {
      on(/com\/youtube\/v3\/videos\?/, () => json({ items: [{ id: 'vid1', status }] }));
      await runStep(await claimed({ verifyAttempts: VERIFY_ATTEMPTS - 1 }));
      expect(await saved()).toMatchObject({
        state: 'FAILED',
        failedState: 'CLAIMED_COMPLETE',
        error,
      });
      expect(await publishes()).toEqual([]);
    },
  );

  it('waits on YouTube while the video is not listed yet', async () => {
    on(/com\/youtube\/v3\/videos\?/, () => json({ items: [] }));
    expect(await runStep(await claimed({ verifyAttempts: 2 }))).toEqual({
      wait: WAITING_ON_YOUTUBE,
    });
    expect(await saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', verifyAttempts: 3 });
  });

  it(`fails after ${VERIFY_ATTEMPTS} empty read-backs`, async () => {
    on(/com\/youtube\/v3\/videos\?/, () => json({ items: [] }));
    expect(await runStep(await claimed({ verifyAttempts: VERIFY_ATTEMPTS - 1 }))).toEqual({});
    expect(await saved()).toMatchObject({ state: 'FAILED', failedState: 'CLAIMED_COMPLETE' });
    expect((await saved()).error).toBe('YouTube never returned the uploaded video.');
  });

  it('fails when there is no channel to read back from', async () => {
    await runStep(await claimed({ destination: null }));
    expect(await saved()).toMatchObject({ state: 'FAILED', failedState: 'CLAIMED_COMPLETE' });
  });

  it('fails when there is no video to read back', async () => {
    await runStep(await claimed({ videoId: null }));
    expect(await saved()).toMatchObject({ state: 'FAILED', error: 'Cannot read the upload back.' });
  });

  it('waits to reconnect when the grant was revoked, keeping the video ID', async () => {
    await revokeA();
    expect(await runStep(await claimed())).toEqual({ wait: RECONNECT });
    expect(await saved()).toMatchObject({
      state: 'CLAIMED_COMPLETE',
      videoId: 'vid1',
      verifyAttempts: 0,
      consecutiveFailures: 0,
    });
    expect(called(/com\/youtube\/v3\/videos\?/)).toHaveLength(0);
  });

  it('records a failure when the grant refresh errors, keeping the connection', async () => {
    h.refreshError = new Error('ECONNRESET');
    expect(await runStep(await claimed())).toEqual({ wait: WAITING_ON_YOUTUBE });
    expect(await saved()).toMatchObject({
      state: 'CLAIMED_COMPLETE',
      videoId: 'vid1',
      verifyAttempts: 0,
      consecutiveFailures: 1,
      error: "Couldn't refresh the YouTube grant.",
    });
    const [connection] = await db()
      .select()
      .from(connections)
      .where(eq(connections.uid, A_JOB.ownerUid));
    expect(connection).toMatchObject({ status: 'connected' });
    expect(called(/com\/youtube\/v3\/videos\?/)).toHaveLength(0);
  });

  it('records a failure when the grant is on another channel, keeping the video ID', async () => {
    await db()
      .update(connections)
      .set({ channelId: 'UCother' })
      .where(eq(connections.uid, A_JOB.ownerUid));
    expect(await runStep(await claimed())).toEqual({ wait: WAITING_ON_YOUTUBE });
    expect(await saved()).toMatchObject({
      state: 'CLAIMED_COMPLETE',
      videoId: 'vid1',
      consecutiveFailures: 1,
      error: "Connected channel doesn't match this job's channel.",
    });
    expect(called(/com\/youtube\/v3\/videos\?/)).toHaveLength(0);
  });

  it('holds the daily-limit wait with no grant refresh or YouTube call', async () => {
    h.refreshError = new Error('a refresh would fail the step');
    const limitUntil = Date.now() + 60_000;
    expect(await runStep(await claimed({ limitUntil }))).toEqual({ wait: DAILY_LIMIT });
    expect(calls).toHaveLength(0);
    expect(await saved()).toMatchObject({
      state: 'CLAIMED_COMPLETE',
      verifyAttempts: 0,
      consecutiveFailures: 0,
      limitUntil,
    });
  });

  it('waits until the Pacific midnight reset when the read-back finds the limit spent', async () => {
    vi.setSystemTime(NOON_PACIFIC);
    on(/com\/youtube\/v3\/videos\?/, () => new Response('quotaExceeded', { status: 403 }));
    expect(await runStep(await claimed({ consecutiveFailures: 1, error: 'stale' }))).toEqual({
      wait: DAILY_LIMIT,
    });
    expect(await saved()).toMatchObject({
      state: 'CLAIMED_COMPLETE',
      verifyAttempts: 0,
      consecutiveFailures: 0,
      error: null,
      limitUntil: quotaResetAt(NOON_PACIFIC),
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('waits to reconnect and revokes the grant when the read-back is refused', async () => {
    on(/com\/youtube\/v3\/videos\?/, () => new Response('unauthorized', { status: 401 }));
    expect(await runStep(await claimed())).toEqual({ wait: RECONNECT });
    expect(await saved()).toMatchObject({
      state: 'CLAIMED_COMPLETE',
      videoId: 'vid1',
      verifyAttempts: 0,
      consecutiveFailures: 0,
    });
    const [connection] = await db()
      .select()
      .from(connections)
      .where(eq(connections.uid, A_JOB.ownerUid));
    expect(connection).toMatchObject({ status: 'revoked', tokenCiphertext: null });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('clears a passed limit once the read-back answers', async () => {
    on(/com\/youtube\/v3\/videos\?/, () => json({ items: [] }));
    expect(await runStep(await claimed({ limitUntil: Date.now() - 1 }))).toEqual({
      wait: WAITING_ON_YOUTUBE,
    });
    expect(await saved()).toMatchObject({ verifyAttempts: 1, limitUntil: null });
  });

  it('clears a passed limit when the read-back verifies', async () => {
    await runStep(await claimed({ limitUntil: Date.now() - 1 }));
    expect(await saved()).toMatchObject({ state: 'VERIFIED', limitUntil: null });
  });

  it('counts a read-back error as a failure and asks the page to wait', async () => {
    on(/com\/youtube\/v3\/videos\?/, () => new Response('oops', { status: 500 }));
    expect(await runStep(await claimed())).toEqual({ wait: WAITING_ON_YOUTUBE });
    expect(await saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', consecutiveFailures: 1 });
  });
});

describe('failurePatch', () => {
  it('records the first failure and keeps the state', () => {
    expect(failurePatch(jobDoc({ state: 'ANALYZE' }), new Error('boom'))).toEqual({
      consecutiveFailures: 1,
      error: 'boom',
    });
  });

  it('fails the job at its current state on the second failure in a row', () => {
    expect(failurePatch(jobDoc({ state: 'ANALYZE', consecutiveFailures: 1 }), 'down')).toEqual({
      state: 'FAILED',
      failedState: 'ANALYZE',
      error: 'down',
      consecutiveFailures: 2,
    });
  });

  it('stringifies non-Error throws', () => {
    expect(failurePatch(jobDoc(), 42).error).toBe('42');
  });

  it('drops the signature from a signed URL quoted in the error', () => {
    const error = new Error(
      'ffmpeg exited 1: https://storage.googleapis.com/bkt/uploads/j1?X-Goog-Signature=abc123: Server returned 403',
    );
    const { error: stored } = failurePatch(jobDoc(), error);
    expect(stored).toBe(
      'ffmpeg exited 1: https://storage.googleapis.com/bkt/uploads/j1?[redacted] Server returned 403',
    );
    expect(stored).not.toContain('X-Goog-Signature');
  });
});

describe('runStep: claim safety', () => {
  it('runs the step on the job read inside the claim, not the caller snapshot', async () => {
    const stale = await pickJob();
    await patchJob({ state: 'REVIEW' });
    expect(await runStep(stale)).toEqual({});
    expect((await saved()).state).toBe('REVIEW');
    expect(await claimToken()).toBeNull();
    expect(chatBodies()).toHaveLength(0);
  });

  it('waits on a loading model when the claimed state is ahead of the snapshot', async () => {
    const stale = await put({ state: 'PREP' });
    await patchJob({ state: 'ANALYZE', chunkCount: 2 });
    on(/127\.0\.0\.1:8081\/health$/, () => new Response('loading', { status: 503 }));
    expect(await runStep(stale)).toEqual({ wait: WAKING });
    expect(await saved()).toMatchObject({ state: 'ANALYZE' });
    expect(chatBodies()).toHaveLength(0);
  });

  it('drops the step result when the job was discarded mid-step', async () => {
    const job = await pickJob();
    on(/v1\/chat\/completions$/, async () => {
      await patchJob({ state: 'DISCARDED' });
      return completion(JSON.stringify(RAW_PICK));
    });
    await runStep(job);
    expect((await saved()).state).toBe('DISCARDED');
    expect(await claimToken()).toBeNull();
    expect(await pickAt(1)).toBeUndefined();
  });
});

describe('runStep: Short', () => {
  const SHORT = {
    sourceDurationSec: 180,
    reframe: 'blur' as const,
    hook: null,
    skipped: [],
    renders: 0,
    modelMs: 0,
  };
  const hookReply = (hook: unknown) =>
    on(/\/v1\/chat\/completions$/, () => completion(JSON.stringify(hook)));

  const loudLines = (from: number, to: number, at: number) => {
    const lines: string[] = [];
    for (let t = 0.1; from + t <= to + 1e-9; t = Math.round((t + 0.1) * 10) / 10) {
      lines.push(`t: ${t}  TARGET:-23 LUFS    M: ${from + t <= at ? -40 : -12} S: -20`);
    }
    return lines.join('\n');
  };

  beforeEach(async () => {
    await put({ id: 'p1', state: 'REVIEW' });
    await seed({
      jobChunks: Array.from({ length: 6 }, (_, i) => ({
        jobId: 'p1',
        index: i,
        data: {
          index: i,
          startSec: i * 29.5,
          durationSec: 29.5,
          measurements: MEASURED,
          analysis: ANALYSIS,
          raw: null,
          modelMs: 1,
        },
      })),
    });
    h.objects.set(SOURCE_OBJECT, { size: '9000', contentType: 'video/mp4' });
    h.upload.mockReset();
    h.upload.mockResolvedValue([{}]);
    h.spawn.mockImplementation((command: string, args: string[]) => {
      if (command === 'ffprobe') {
        return child({
          stdout: JSON.stringify({
            format: { duration: '30' },
            streams: [{ codec_type: 'video', width: 1080, height: 1920 }, { codec_type: 'audio' }],
          }),
        });
      }
      if (args.includes('-movflags')) return child({});
      return child({ stderr: loudLines(56, 90.5, 70) });
    });
  });

  it('runs HOOK then RENDER into REVIEW, one step per call', async () => {
    hookReply({ window: 2, lengthSec: 30, reason: 'The chorus lands.' });
    const job = await put({
      state: 'HOOK',
      parentId: 'p1',
      short: SHORT,
      sourceObject: SOURCE_OBJECT,
      pickVersion: 1,
    });

    expect(await runStep(job)).toEqual({});
    expect((await saved()).state).toBe('RENDER');
    expect((await saved()).short!.hook).toEqual({
      window: 2,
      startSec: 70,
      lengthSec: 30,
      reason: 'The chorus lands.',
    });
    expect(chatBodies().at(-1)).toMatchObject({
      response_format: { json_schema: { name: 'hook_pick' } },
    });

    expect(await runStep(await saved())).toEqual({});
    expect(await saved()).toMatchObject({
      state: 'REVIEW',
      object: 'uploads/j1-1',
      probe: { width: 1080, height: 1920 },
      short: { renders: 1 },
    });
  });

  it('waits for the model before picking the hook', async () => {
    on(/\/health$/, () => new Response('loading', { status: 503 }));
    const result = await runStep(
      await put({ state: 'HOOK', parentId: 'p1', short: SHORT, sourceObject: SOURCE_OBJECT }),
    );
    expect(result).toEqual({ wait: WAKING });
    expect((await saved()).state).toBe('HOOK');
    expect(await claimToken()).toBeNull();
  });

  it('renders without waiting on the model, which it does not use', async () => {
    on(/\/health$/, () => new Response('loading', { status: 503 }));
    const hook = { window: 2, startSec: 70, lengthSec: 30, reason: 'x' };
    await runStep(
      await put({
        state: 'RENDER',
        parentId: 'p1',
        short: { ...SHORT, hook },
        sourceObject: SOURCE_OBJECT,
      }),
    );
    expect(called(/\/health$/)).toHaveLength(0);
    expect((await saved()).state).toBe('REVIEW');
  });

  it('fails at HOOK after two unparsed replies in a row, ready for a retry', async () => {
    on(/\/v1\/chat\/completions$/, () => completion('nope'));
    await put({ state: 'HOOK', parentId: 'p1', short: SHORT, sourceObject: SOURCE_OBJECT });
    await runStep(await saved());
    expect(await saved()).toMatchObject({ state: 'HOOK', consecutiveFailures: 1 });
    await runStep(await saved());
    expect(await saved()).toMatchObject({
      state: 'FAILED',
      failedState: 'HOOK',
      error: 'The model reply did not parse as a hook.',
    });
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { step: 'HOOK' },
    });
  });

  it('fails at HOOK in one step when the model keeps repeating a skipped hook', async () => {
    on(/\/v1\/chat\/completions$/, () =>
      completion(JSON.stringify({ window: 2, lengthSec: 30, reason: 'x' })),
    );
    const skipped = [{ window: 2, lengthSec: 30 }];
    await put({
      state: 'HOOK',
      parentId: 'p1',
      short: { ...SHORT, skipped },
      sourceObject: SOURCE_OBJECT,
    });
    await runStep(await saved());
    expect(await saved()).toMatchObject({
      state: 'FAILED',
      failedState: 'HOOK',
      error: 'The model kept picking a skipped hook.',
    });
    expect(called(/\/v1\/chat\/completions$/)).toHaveLength(2);
  });

  it('fails the render when the upload to storage is refused', async () => {
    h.upload.mockRejectedValue(new Error('403 Forbidden'));
    const hook = { window: 2, startSec: 70, lengthSec: 30, reason: 'x' };
    const job = await put({
      state: 'RENDER',
      parentId: 'p1',
      short: { ...SHORT, hook },
      sourceObject: SOURCE_OBJECT,
      consecutiveFailures: 1,
    });
    await runStep(job);
    expect(await saved()).toMatchObject({
      state: 'FAILED',
      failedState: 'RENDER',
      error: '403 Forbidden',
    });
  });
});

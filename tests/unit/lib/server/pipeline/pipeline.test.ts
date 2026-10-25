// @vitest-environment node
import { existsSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { seed, truncate, vanishOnUpdate } from '../../../../helpers/db';
import { agentSpanIO, clearAgentSpan } from '../../../../helpers/agent-span';
import {
  A_JOB,
  approvedGuide,
  ANALYSIS,
  ARTIST,
  ARTIST_A,
  ARTIST_C,
  C_JOB,
  CHANNEL_A,
  REFRESH_C,
  USER_C,
  child,
  REFRESH_A,
  defaultHandlers,
  headers,
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
import {
  badRequest400,
  busy429,
  geminiError,
  interaction,
  perDay429,
  unavailable503,
} from '../../../../helpers/gemini';
import { captureException, captureMessage, span, startSpan } from '../../../../mocks/sentry';
import type { BrandGuide } from '#lib/brand.js';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import {
  artistGuides,
  artistMemory,
  artists,
  connections,
  jobAudience,
  jobs,
  researchRuns,
  users,
} from '#lib/server/core/schema.js';
import { discard, rerun, retry } from '#lib/server/jobs/actions.js';
import { runDelivery } from '#lib/server/research/delivery.js';
import { RESEARCH_MAX_MS } from '#lib/server/research/runs.js';
import { getJob, MAX_MINUTES, outcomeUnknown, type JobDoc } from '#lib/server/jobs/jobs.js';
import { jobSet, type JobPatch } from '#lib/server/jobs/rows.js';
import { saveAudience } from '#lib/server/jobs/audience.js';
import type { AudienceEvidence } from '#lib/server/pipeline/hashtags.js';
import { failurePatch, runStep, VERIFY_ATTEMPTS } from '#lib/server/pipeline/pipeline.js';
import { HOOK_SCHEMA } from '#lib/server/pipeline/short.js';
import { clearStatsCache } from '#lib/server/platforms/youtube/youtube.js';
import { quotaResetAt } from '#lib/server/core/quota.js';
import { COPIED, evidence, PEER_TITLE } from '../../../../helpers/evidence';

const ARTIST_NAME_KEY = 'artist-name';
const BAD_PICK_JSON = '{"title": 1}';
const WAITING_ON_YOUTUBE = 'waiting on YouTube';
const RECONNECT = 'reconnect YouTube';
const OUTCOME_UNKNOWN = 'upload outcome unknown';
const DAILY_LIMIT = 'Daily upload limit reached. Try tomorrow.';
const A_TOKEN = `Bearer access:${REFRESH_A}`;
const C_TOKEN = `Bearer access:${REFRESH_C}`;
const NO_ARTIST = 'Add your artist name first.';
const SOURCE_OBJECT = 'uploads/p1';
// Far from the Pacific midnight reset, so the step and the assertion see the same reset.
const NOON_PACIFIC = Date.parse('2026-10-18T19:00:00Z');

const h = vi.hoisted(() => ({
  objects: new Map<string, { size?: string; contentType?: string }>(),
  spawn: vi.fn(),
  upload: vi.fn(),
  refreshError: null as Error | null,
  exists: null as null | (() => Promise<boolean>),
  deleted: [] as string[],
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
          exists: async () => [h.exists ? await h.exists() : h.objects.has(object)],
          getMetadata: async () => [h.objects.get(object)],
        }),
        getFiles: async ({ prefix }: { prefix: string }) => [
          [...h.objects.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({
              name: key,
              delete: async () => {
                h.deleted.push(key);
                h.objects.delete(key);
              },
            })),
        ],
      };
    }
  },
}));

// Each grant mints its own token, so a request's Authorization header names the grant behind it.
vi.mock('google-auth-library', () => ({
  // Application Default Credentials, for Cloud Tasks.
  GoogleAuth: class {
    getAccessToken = async () => 'tasks-access-token';
  },
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

let tools: { probe: Run; measure: Run; clip: Run; range: Run };
/** Order of the media and model calls a step makes. */
const events: string[] = [];
/** Simulated time each media call takes. */
let mediaMs = { cut: 0, measure: 0 };
let clock: number | null = null;
const CLIP = Buffer.from('window-clip-mp4');

let handlers: Handler[];
const calls: { url: string; init: RequestInit }[] = [];

/** Later registrations win over the defaults. */
const on = (test: RegExp, reply: Handler['reply']) => handlers.unshift({ test, reply });
const called = (test: RegExp) => calls.filter((c) => test.test(c.url));
const GEMINI = /generativelanguage\.googleapis\.com\/v1beta\/interactions$/;
const chatBodies = () =>
  called(GEMINI).map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);
const clipPaths = () =>
  (h.spawn.mock.calls as [string, string[]][])
    .map(([, args]) => args.at(-1)!)
    .filter((path) => path.endsWith('.mp4'));
const advance = (ms: number) => {
  if (clock !== null) clock += ms;
};

const put = (patch: Partial<JobDoc> = {}) => seedJob(patch);
const saved = async () => (await getJob('j1'))!;
const patchJob = (fields: JobPatch) =>
  db().transaction(async (tx) => {
    await tx.update(jobs).set(jobSet(fields)).where(eq(jobs.id, 'j1'));
    if (fields.audience) await saveAudience(tx, 'j1', fields.audience);
  });
const claimToken = async () =>
  (await db().select({ token: jobs.claimToken }).from(jobs).where(eq(jobs.id, 'j1')))[0]!.token;
const arrays = async () =>
  (
    await db()
      .select({ picks: jobs.picks, chunks: jobs.chunks })
      .from(jobs)
      .where(eq(jobs.id, 'j1'))
  )[0]! as {
    picks: Record<string, unknown>[];
    chunks: Record<string, unknown>[];
  };
/** Chunk i is stored at index i. */
const chunkAt = async (index: number) => (await arrays()).chunks[index];
/** Pick v is stored at index v - 1. */
const pickAt = async (version: number) => (await arrays()).picks[version - 1];
const setChunks = (id: string, chunks: unknown[]) =>
  db().update(jobs).set({ chunks }).where(eq(jobs.id, id));
const artistRows = (kind: (typeof artistMemory.kind.enumValues)[number]) =>
  db().select().from(artistMemory).where(eq(artistMemory.kind, kind));
const unlinkA = () => db().update(users).set({ artistId: null }).where(eq(users.uid, USER_A.uid));
const revokeA = () =>
  db()
    .update(connections)
    .set({ status: 'revoked', tokenCiphertext: null })
    .where(eq(connections.uid, USER_A.uid));
const artistRowCount = async () => (await db().select().from(artistMemory)).length;
const FIELDS = {
  title: 'PeekaBoo',
  description: 'd #synthwave',
  hashtags: [SYNTHWAVE],
  tags: ['a'],
};
const PROBE = { durationSec: 40, width: 1920, height: 1080, hasAudio: true };
/** Two 60 s windows: 0–60 and 60–100. */
const PROBE_100 = { ...PROBE, durationSec: 100 };
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
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'secret');
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  resetClients();
  await truncate();
  await seed(USERS);
  clearStatsCache();
  h.objects.clear();
  h.refreshError = null;
  h.exists = null;
  h.deleted.length = 0;
  h.objects.set('uploads/j1', { size: '1000', contentType: 'video/quicktime' });
  tools = {
    probe: { stdout: probeJson(95) },
    measure: { stderr: MEASURE_STDERR },
    clip: {},
    range: { stderr: MEASURE_STDERR },
  };
  events.length = 0;
  mediaMs = { cut: 0, measure: 0 };
  clock = null;
  h.spawn.mockReset();
  h.spawn.mockImplementation((command: string, args: string[]) => {
    if (command === 'ffprobe') return child(tools.probe);
    const out = args.at(-1)!;
    if (out.endsWith('.mp4')) {
      events.push('cut');
      advance(mediaMs.cut);
      if (!tools.clip.code) writeFileSync(out, CLIP);
      return child(tools.clip);
    }
    if (!args.includes('-ss')) return child(tools.measure);
    events.push('measure');
    advance(mediaMs.measure);
    return child(tools.range);
  });
  handlers = defaultHandlers();
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (GEMINI.test(url)) events.push('model');
      const handler = handlers.find((x) => x.test.test(url));
      if (!handler) throw new Error(`unexpected fetch ${url}`);
      return handler.reply(url, init);
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(await claimToken()).toBeNull();
  });

  const UPLOAD = {
    sessionCipher: 'c2Vzc2lvbg==',
    generation: 2,
    size: 1000,
    fingerprint: 'a'.repeat(64),
    ops: [],
  };
  const CURRENT = 'uploads/j1/current';
  const ORPHAN = 'uploads/j1/orphan';
  const awaiting = () =>
    put({ state: 'AWAITING_UPLOAD', object: CURRENT, videoUpload: UPLOAD, consecutiveFailures: 0 });

  it('moves on for the current object, clears the upload, sweeps orphans and drops the claim', async () => {
    h.objects.set(CURRENT, { size: '1000', contentType: 'video/mp4' });
    h.objects.set(ORPHAN, { size: '10' });
    h.objects.set('uploads/j1-1', { size: '5' });
    expect(await runStep(await awaiting())).toEqual({});
    expect(await saved()).toMatchObject({ state: 'PREP', videoUpload: null, object: CURRENT });
    expect(h.deleted).toEqual([ORPHAN]);
    expect(h.objects.has('uploads/j1-1')).toBe(true);
    expect(await claimToken()).toBeNull();
  });

  it('never moves on for an orphan while the current object is missing', async () => {
    h.objects.set(ORPHAN, { size: '1000' });
    expect(await runStep(await awaiting())).toEqual({});
    expect(await saved()).toMatchObject({ state: 'AWAITING_UPLOAD', videoUpload: UPLOAD });
    expect(h.deleted).toEqual([]);
  });

  it('keeps waiting when a pick swapped the object between the read and the release', async () => {
    h.objects.set(CURRENT, { size: '1000' });
    h.exists = async () => {
      await patchJob({ object: 'uploads/j1/newer' });
      return true;
    };
    expect(await runStep(await awaiting())).toEqual({});
    expect(await saved()).toMatchObject({ state: 'AWAITING_UPLOAD', object: 'uploads/j1/newer' });
    expect(await claimToken()).toBeNull();
    expect(h.deleted).toEqual([]);
  });

  it('still moves on when the sweep fails', async () => {
    h.objects.set(CURRENT, { size: '1000' });
    h.objects.set(ORPHAN, { size: '10' });
    vi.spyOn(h.deleted, 'push').mockImplementation(() => {
      throw new Error('403');
    });
    expect(await runStep(await awaiting())).toEqual({});
    expect((await saved()).state).toBe('PREP');
  });

  it('moves the job once when two steps complete it at the same time', async () => {
    h.objects.set(CURRENT, { size: '1000' });
    const job = await awaiting();
    const results = await Promise.all([runStep(job), runStep(job)]);
    expect(results).toContainEqual({ wait: 'step running in another tab' });
    expect(results).toContainEqual({});
    expect((await saved()).state).toBe('PREP');
  });

  it('waits on a stalled storage read at the step deadline, with no failure counted', async () => {
    vi.useFakeTimers({ now: NOON_PACIFIC, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    h.exists = () => new Promise(() => {});
    const stepping = runStep(await awaiting());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stepping).toEqual({});
    expect(await saved()).toMatchObject({
      state: 'AWAITING_UPLOAD',
      consecutiveFailures: 0,
      error: null,
      videoUpload: UPLOAD,
    });
    expect(await claimToken()).toBeNull();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { step: 'AWAITING_UPLOAD' },
    });
  });

  it('answers the other-tab wait while another step holds the claim', async () => {
    const job = await awaiting();
    await db()
      .update(jobs)
      .set({ claimToken: 'other', claimUntil: sql`now() + interval '1 minute'` })
      .where(eq(jobs.id, 'j1'));
    expect(await runStep(job)).toEqual({ wait: 'step running in another tab' });
  });

  it('releases without a change when the job left AWAITING_UPLOAD before the claim', async () => {
    const job = await awaiting();
    await patchJob({ state: 'DISCARDED' });
    expect(await runStep(job)).toEqual({});
    expect((await saved()).state).toBe('DISCARDED');
    expect(await claimToken()).toBeNull();
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
    expect(job.chunkCount).toBe(2);
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
    expect((await saved()).chunkCount).toBe(15);
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
  const analyzeJob = (patch: Partial<JobDoc> = {}) =>
    put({ state: 'ANALYZE', probe: PROBE_100, chunkCount: 2, chunkIndex: 0, ...patch });

  it('stores no chunk when the job was discarded mid-analysis', async () => {
    const job = await analyzeJob();
    on(GEMINI, async () => {
      await patchJob({ state: 'DISCARDED' });
      return interaction(JSON.stringify(ANALYSIS));
    });
    await runStep(job);
    expect((await saved()).state).toBe('DISCARDED');
    expect(await chunkAt(0)).toBeUndefined();
  });

  it('cuts, measures, then asks the analyst, sending the clip inline and deleting it', async () => {
    const result = await runStep(await analyzeJob());
    expect(result).toEqual({});
    expect(events).toEqual(['cut', 'measure', 'model']);
    expect(await saved()).toMatchObject({
      state: 'ANALYZE',
      chunkIndex: 1,
      consecutiveFailures: 0,
    });
    const chunk = (await chunkAt(0))!;
    expect(chunk).toMatchObject({ index: 0, startSec: 0, durationSec: 60, raw: null });
    expect(chunk.measurements).toMatchObject({ integratedLufs: -13.8, truePeakDbtp: -0.4 });
    expect(chunk.analysis).toEqual(ANALYSIS);
    const body = chatBodies()[0] as {
      model: string;
      input: { content: { type: string; data?: string }[] }[];
    };
    expect(body.model).toBe('gemini-3.8-flash');
    const video = body.input[0]!.content.find((c) => c.type === 'video')!;
    expect(video.data).toBe(CLIP.toString('base64'));
    expect(JSON.stringify(body)).not.toContain('storage.googleapis.com');
    expect(clipPaths()).toHaveLength(1);
    expect(existsSync(clipPaths()[0]!)).toBe(false);
  });

  it('moves to PICK after the last chunk, cutting the short tail window', async () => {
    const job = await analyzeJob({ chunkIndex: 1 });
    await setChunks('j1', [{ index: 0 }]);
    await runStep(job);
    expect(await saved()).toMatchObject({ state: 'PICK', chunkIndex: 2 });
    expect(await chunkAt(1)).toMatchObject({ index: 1, startSec: 60, durationSec: 40 });
    for (const [, args] of h.spawn.mock.calls as [string, string[]][]) {
      expect(args[args.indexOf('-ss') + 1]).toBe('60.000');
      expect(args[args.indexOf('-t') + 1]).toBe('40.000');
    }
  });

  it('deletes the clip and saves no chunk when the model call throws', async () => {
    on(GEMINI, () => badRequest400());
    await runStep(await analyzeJob());
    expect(events).toEqual(['cut', 'measure', 'model']);
    expect(await saved()).toMatchObject({
      state: 'ANALYZE',
      chunkIndex: 0,
      consecutiveFailures: 1,
    });
    expect((await saved()).error).toMatch(/^Gemini 400/);
    expect(await chunkAt(0)).toBeUndefined();
    expect(existsSync(clipPaths()[0]!)).toBe(false);
  });

  it('deletes the clip when the window measurement fails, asking no model', async () => {
    tools.range = { code: 1, stderr: 'measure broke' };
    await runStep(await analyzeJob());
    expect(events).toEqual(['cut', 'measure']);
    expect((await saved()).error).toMatch(/ffmpeg exited 1/);
    expect(existsSync(clipPaths()[0]!)).toBe(false);
  });

  it('shares one step deadline across cut, measure and the model call', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    clock = NOON_PACIFIC;
    vi.spyOn(Date, 'now').mockImplementation(() => clock!);
    mediaMs = { cut: 90_000, measure: 10_000 };
    await runStep(await analyzeJob());
    // 110 s budget less the 5 s reserve: the cut gets its 45 s cap, the measure the 15 s left.
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([45_000, 15_000]);
    // 5 s remain, under the analyst's 8 s minimum: no model call, a counted failure.
    expect(events).toEqual(['cut', 'measure']);
    expect(await saved()).toMatchObject({
      consecutiveFailures: 1,
      error: 'The step ran out of time for the model.',
    });
    expect(existsSync(clipPaths()[0]!)).toBe(false);
  });

  it('makes the model call while the shared deadline still has room', async () => {
    clock = NOON_PACIFIC;
    vi.spyOn(Date, 'now').mockImplementation(() => clock!);
    mediaMs = { cut: 40_000, measure: 40_000 };
    await runStep(await analyzeJob());
    expect(events).toEqual(['cut', 'measure', 'model']);
    expect((await saved()).chunkIndex).toBe(1);
  });

  it('sends a job counted under another window length back to PREP, clearing its chunks', async () => {
    const job = await analyzeJob({
      chunkCount: 4,
      chunkIndex: 2,
      consecutiveFailures: 1,
      error: 'x',
    });
    await setChunks('j1', [{ index: 0 }, { index: 1 }]);
    expect(await runStep(job)).toEqual({});
    expect(await saved()).toMatchObject({
      state: 'PREP',
      chunkIndex: 0,
      consecutiveFailures: 0,
      error: null,
    });
    expect((await arrays()).chunks).toEqual([]);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(chatBodies()).toHaveLength(0);
    expect(await claimToken()).toBeNull();
  });

  it('keeps the chunks when another worker took the claim before the reset landed', async () => {
    const job = await analyzeJob({ chunkCount: 4, chunkIndex: 2 });
    await setChunks('j1', [{ index: 0 }, { index: 1 }]);
    startSpan.mockImplementationOnce(async (_options, fn) => {
      await db().update(jobs).set({ claimToken: 'other' }).where(eq(jobs.id, 'j1'));
      return fn(span);
    });
    await runStep(job);
    expect(await saved()).toMatchObject({ state: 'ANALYZE', chunkIndex: 2 });
    expect((await arrays()).chunks).toHaveLength(2);
    expect(captureMessage).toHaveBeenCalledWith(
      'Step result dropped: the claim lapsed or the job moved on',
      expect.anything(),
    );
  });

  /** Second window of three, with the first already analyzed. */
  const analyzing = async () => {
    const job = await analyzeJob({
      probe: { ...PROBE, durationSec: 150 },
      chunkCount: 3,
      chunkIndex: 1,
    });
    await setChunks('j1', [{ index: 0 }]);
    return job;
  };

  it("stores an ffmpeg failure without the signed URL's signature", async () => {
    tools.clip = {
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
    tools.clip = { code: 1, stderr: 'boom\nmoov atom not found' };
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

  it('resets the failure count after a step succeeds', async () => {
    await runStep(await analyzeJob({ consecutiveFailures: 1 }));
    expect(await saved()).toMatchObject({ consecutiveFailures: 0, error: null, chunkIndex: 1 });
  });

  it('keeps the raw reply when the model never returns valid JSON', async () => {
    on(GEMINI, () => interaction('not json'));
    await runStep(await analyzeJob());
    expect(await chunkAt(0)).toMatchObject({ analysis: null, raw: 'not json' });
    expect((await saved()).chunkIndex).toBe(1);
  });
});

const chunkDoc = (index: number) => ({
  index,
  startSec: index * 60,
  durationSec: 60,
  measurements: MEASURED,
  analysis: ANALYSIS,
  raw: null,
  modelMs: 4000,
});

/** The last pick request's system rules. */
const rules = () => JSON.stringify(chatBodies().at(-1)!);
const context = () => {
  const body = chatBodies().at(-1)!;
  const input = body.input as { content: { type: string; text?: string }[] }[];
  // The provider joins adjacent text parts: the context, then each YouTube part, then the caption.
  const lines = input[0]!.content[0]!.text!.split('\n').filter((line) => line.startsWith('{'));
  return Object.assign({}, ...lines.map((line) => JSON.parse(line) as object)) as {
    artist: string | null;
    facts: { key: string }[];
    feedback: unknown[];
    skippedVersions?: { title: string }[];
    candidateLists: {
      videoId: string;
      title: string;
      hashtags: string[];
      tags: { tag: string }[];
    }[];
    audienceTopVideos: unknown[];
    similarArtists?: Record<string, unknown>;
    artistResults?: Record<string, unknown>;
    recentUploads?: unknown[];
    brandGuide?: unknown;
  };
};

const PROFILE_OF: Partial<Record<string, string>> = {
  [USER_A.uid]: USER_A.artistId,
  [USER_C.uid]: USER_C.artistId,
};

/**
 * A finished research run for job `j1` that found no peers, so the pick goes ahead. None for an
 * owner without a profile, who never gets that far.
 */
async function researched(job: Pick<JobDoc, 'ownerUid'>, patch = {}): Promise<void> {
  const artistId = PROFILE_OF[job.ownerUid];
  if (!artistId) return;
  await seed({
    researchRuns: [
      {
        jobId: 'j1',
        id: 'run-1',
        ownerUid: job.ownerUid,
        artistId,
        stage: 'done',
        limits: ['analytics-not-shared', 'no-peers'],
        ...patch,
      },
    ],
  });
}

/**
 * The PICK step's job, C's by default, with its two analyzed chunks (they need the job row) and a
 * finished research run.
 */
async function pickJob(patch: Partial<JobDoc> = {}): Promise<JobDoc> {
  const job = await put({ state: 'PICK', ...C_JOB, ...patch });
  await setChunks('j1', [0, 1].map(chunkDoc));
  await researched(job);
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

const refusal = (status: number, reason?: string) =>
  json(reason ? { error: { errors: [{ reason }] } } : {}, { status });
const connectionOf = async (uid: string) =>
  (await db().select().from(connections).where(eq(connections.uid, uid)))[0];
const googleError = (error: string) =>
  Object.assign(new Error(error), { response: { status: 400, data: { error } } });

describe('runStep: PICK', () => {
  it("picks another artist's job under its own name, reading its own channel", async () => {
    expect(await runStep(await pickJob({ measurements: MEASURED }))).toEqual({});
    const job = await saved();
    expect(job.state).toBe('REVIEW');
    expect(job.hashtagCandidates).toEqual([SYNTHWAVE, RETROWAVE, '#newmusic']);
    const pick = (await pickAt(1))!;
    expect(pick).toMatchObject({ version: 1, skipped: false, artistName: ARTIST_C.name });
    expect((pick.tags as string[])[0]).toBe(ARTIST_C.name);
    expect(typeof pick.modelMs).toBe('number');
    for (const tag of pick.hashtags as string[]) expect(job.hashtagCandidates).toContain(tag);
    expect(pick.description).toContain(`\n${ARTIST_C.contactLine}\n\n#`);

    const ctx = context();
    expect(ctx.artist).toBe(ARTIST_C.name);
    expect(ctx.facts).toEqual([
      { key: ARTIST_NAME_KEY, value: ARTIST_C.name, kind: 'FACT', public: true },
    ]);
    expect(ctx.feedback).toEqual([]);
    expect(ctx.skippedVersions).toBeUndefined();
    expect(ctx.recentUploads).toHaveLength(3);
    const identity = calls.filter((c) => /youtube\/v3\/(channels|playlistItems)/.test(c.url));
    expect(identity.map((c) => headers(c.init).authorization)).toEqual([C_TOKEN, C_TOKEN]);
    expect(new URL(identity[0]!.url).searchParams.get('mine')).toBe('true');
    const sent = rules();
    for (const flr of [ARTIST, 'flieslikerobots', 'hacked and slashed', ARTIST_C.contactLine]) {
      expect(sent).not.toContain(flr);
    }
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(1);
    expect(job.audience?.candidateLists.flatMap((list) => list.hashtags)).toEqual(
      job.hashtagCandidates,
    );
  });

  it('records the pick request, with YouTube text as counts, and the stored pick', async () => {
    clearAgentSpan();
    await runStep(await pickJob({ measurements: MEASURED }));
    const { input, output } = agentSpanIO();
    expect(input).toHaveLength(1);
    const messages = input[0]!['gen_ai.input.messages'] as string;
    expect(messages).toContain('[YouTube uploads: 3]');
    expect(messages).not.toContain('Out now.');
    expect(messages).not.toContain('Song v1');
    const stored = (await pickAt(1))!;
    expect(JSON.parse(output[0]!)).toMatchObject({ title: stored.title });
  });

  it("writes Nathan's job in his voice, with his contact line, from his own channel", async () => {
    await runStep(await pickJob(A_JOB));
    expect(context().artist).toBe(ARTIST);
    const catalog = called(/com\/youtube\/v3\/videos\?/).map((c) =>
      new URL(c.url).searchParams.get('id'),
    );
    expect(catalog[0]).toBe('v1,v2,v3,v4,v5,v6');
    // Only the three newest uploads go to the model, each with its thumbnail.
    expect(context().recentUploads).toHaveLength(3);
    expect(called(/i\.ytimg\.com/)).toHaveLength(3);
    expect(headers(called(/youtube\/v3\/channels\?/)[0]!.init).authorization).toBe(A_TOKEN);
    expect(rules()).toContain('hacked and slashed');
    const pick = (await pickAt(1))!;
    expect(pick).toMatchObject({ artistName: ARTIST });
    expect(pick.description).toContain(`\n${ARTIST_A.contactLine}\n\n#`);
  });

  it('waits for a profile on a job whose owner has none, with no YouTube or model call', async () => {
    const job = await pickJob({ ownerUid: 'uid-b', artistId: null, consecutiveFailures: 1 });
    expect(await runStep(job)).toEqual({ wait: NO_ARTIST });
    expect(calls).toHaveLength(0);
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
    expect(await claimToken()).toBeNull();
  });

  it('waits on a reconnect when the owner has no connection, with no YouTube or model call', async () => {
    await db().delete(connections).where(eq(connections.uid, USER_C.uid));
    expect(await runStep(await pickJob())).toEqual({ wait: RECONNECT });
    expect(calls).toHaveLength(0);
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 0 });
  });

  it('gives up a grant sealed under another key and waits on a reconnect, with no strike', async () => {
    await db()
      .update(connections)
      .set({ tokenCiphertext: 'sealed-under-another-key' })
      .where(eq(connections.uid, USER_C.uid));
    expect(await runStep(await pickJob())).toEqual({ wait: RECONNECT });
    expect(await connectionOf(USER_C.uid)).toMatchObject({
      status: 'revoked',
      tokenCiphertext: null,
    });
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 0, error: null });
    expect(calls).toHaveLength(0);
  });

  it('marks a revoked grant on refresh and waits on a reconnect, with no model call', async () => {
    h.refreshError = googleError('invalid_grant');
    expect(await runStep(await pickJob())).toEqual({ wait: RECONNECT });
    expect(await connectionOf(USER_C.uid)).toMatchObject({ status: 'revoked' });
    expect(chatBodies()).toHaveLength(0);
  });

  it.each([
    ['a 401', refusal(401)],
    ['a 403 playlistItemsNotAccessible', refusal(403, 'playlistItemsNotAccessible')],
    ['a 403 forbidden', refusal(403, 'forbidden')],
  ])('gives up the grant on %s and waits on a reconnect', async (_label, response) => {
    on(/youtube\/v3\/playlistItems\?/, () => response.clone());
    expect(await runStep(await pickJob({ consecutiveFailures: 1 }))).toEqual({ wait: RECONNECT });
    expect(await connectionOf(USER_C.uid)).toMatchObject({ status: 'revoked' });
    expect(captureMessage).toHaveBeenCalledWith('YouTube refused the grant', {
      level: 'warning',
      tags: { 'job.id': 'j1' },
    });
    expect(await saved()).toMatchObject({ consecutiveFailures: 1 });
    expect(chatBodies()).toHaveLength(0);
  });

  it.each([
    ['a 403 quotaExceeded', refusal(403, 'quotaExceeded')],
    ['a 429', refusal(429)],
    ['a 503', refusal(503)],
  ])('waits on YouTube on %s, leaving the grant and the streak alone', async (_label, response) => {
    on(/youtube\/v3\/playlistItems\?/, () => response.clone());
    expect(await runStep(await pickJob({ consecutiveFailures: 1 }))).toEqual({
      wait: WAITING_ON_YOUTUBE,
    });
    expect(await connectionOf(USER_C.uid)).toMatchObject({ status: 'connected' });
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
    expect(chatBodies()).toHaveLength(0);
  });

  it('fails the step when Google rejects the app, and the job on the second', async () => {
    h.refreshError = googleError('invalid_client');
    await runStep(await pickJob());
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
    await runStep(await saved());
    expect(await saved()).toMatchObject({ state: 'FAILED', failedState: 'PICK' });
    expect(await connectionOf(USER_C.uid)).toMatchObject({ status: 'connected' });
  });

  it('waits on a reconnect when the grant no longer lists the connected channel', async () => {
    on(/youtube\/v3\/channels\?/, () =>
      json({
        items: [{ id: 'UCnew', contentDetails: { relatedPlaylists: { uploads: 'UUnew' } } }],
      }),
    );
    expect(await runStep(await pickJob())).toEqual({ wait: RECONNECT });
    expect(chatBodies()).toHaveLength(0);
    expect(called(/playlistItems/)).toHaveLength(0);
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 0 });
  });

  it('stores none of the owner-read upload text anywhere', async () => {
    const SENTINEL = 'sentinel-7f3a';
    on(/com\/youtube\/v3\/videos\?/, (url) => {
      const ids = new URL(url).searchParams.get('id') ?? '';
      if (!ids.startsWith('v1')) return json({ items: [] });
      return json({
        items: ids.split(',').map((id) => ({
          id,
          snippet: { title: `${SENTINEL} ${id}`, description: SENTINEL, thumbnails: {} },
        })),
      });
    });
    await runStep(await pickJob());
    expect((await saved()).state).toBe('REVIEW');
    expect(rules()).toContain(SENTINEL);
    const stored = await db().execute(
      sql`select (select string_agg(j::text, '') from jobs j) || coalesce((select string_agg(m::text, '') from artist_memory m), '') as text`,
    );
    expect((stored as { rows: { text: string }[] }).rows[0]!.text).not.toContain(SENTINEL);
  });

  it('re-picks under the renamed profile, leaving earlier picks alone (SC-005)', async () => {
    await runStep(await pickJob());
    const first = await pickAt(1);
    await db().update(artists).set({ name: 'Renamed Band' }).where(eq(artists.id, ARTIST_C.id));
    await patchJob({ state: 'PICK' });
    await runStep(await saved());
    expect(await pickAt(1)).toEqual(first);
    expect(await pickAt(2)).toMatchObject({ artistName: 'Renamed Band' });
    expect(((await pickAt(2))!.tags as string[])[0]).toBe('Renamed Band');
  });

  it('leaves approved and verified jobs byte-identical after a rename', async () => {
    const approved = await put({ ...C_JOB, id: 'done', state: 'VERIFIED', finalFields: FIELDS });
    const before = await db().select().from(jobs).where(eq(jobs.id, approved.id));
    await db().update(artists).set({ name: 'Renamed Band' }).where(eq(artists.id, ARTIST_C.id));
    expect(await db().select().from(jobs).where(eq(jobs.id, approved.id))).toEqual(before);
  });
});

describe('runStep: PICK deadline', () => {
  const slow = (ms: number) => () => {
    clock! += ms;
  };
  const startClock = () => {
    clock = NOON_PACIFIC;
    vi.spyOn(Date, 'now').mockImplementation(() => clock!);
  };

  it('waits on the model when a slow identity read leaves too little time', async () => {
    startClock();
    const read = handlers.find((x) =>
      x.test.test('https://www.googleapis.com/youtube/v3/playlistItems?'),
    )!;
    on(/youtube\/v3\/playlistItems\?/, (url, init) => {
      slow(75_000)();
      return read.reply(url, init);
    });
    expect(await runStep(await pickJob({ consecutiveFailures: 1 }))).toEqual({
      wait: 'model busy',
    });
    expect(chatBodies()).toHaveLength(0);
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
    expect(await claimToken()).toBeNull();
  });

  it('waits on the model when slow thumbnails spend the budget', async () => {
    startClock();
    on(/i\.ytimg\.com/, () => {
      slow(25_000)();
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } });
    });
    expect(await runStep(await pickJob())).toEqual({ wait: 'model busy' });
    expect(chatBodies()).toHaveLength(0);
    expect((await saved()).consecutiveFailures).toBe(0);
  });

  it('waits on YouTube when the genre search runs out of time, releasing the claim', async () => {
    startClock();
    on(/youtube\/v3\/search\?/, () => {
      slow(106_000)();
      return json({ items: [{ id: { videoId: 's1' } }] });
    });
    expect(await runStep(await pickJob({ consecutiveFailures: 1 }))).toEqual({
      wait: WAITING_ON_YOUTUBE,
    });
    expect(chatBodies()).toHaveLength(0);
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
    expect(await claimToken()).toBeNull();
  });
});

describe('runStep: PICK research', () => {
  const TASKS = /cloudtasks\.googleapis\.com/;
  const runs = () => db().select().from(researchRuns).where(eq(researchRuns.jobId, 'j1'));
  const delivered = () =>
    called(TASKS).map(({ init }) => {
      const { task } = JSON.parse(String(init.body)) as { task: { httpRequest: { body: string } } };
      return JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString()) as unknown;
    });
  const AUDIENCE: AudienceEvidence = {
    retrievedAt: NOON_PACIFIC,
    query: 'synthwave music video',
    candidateLists: [
      {
        source: 'genre',
        ref: 'G1',
        videoId: 'peer',
        title: 'Peer release',
        hashtags: [SYNTHWAVE],
        tags: [{ tag: 'synthwave' }],
      },
    ],
    top: [],
  };
  /** A PICK job with no research run yet. */
  const unresearched = async (patch: Partial<JobDoc> = {}) => {
    const job = await put({ state: 'PICK', ...C_JOB, ...patch });
    await setChunks('j1', [0, 1].map(chunkDoc));
    return job;
  };

  beforeEach(() => {
    vi.stubEnv('RESEARCH_QUEUE', 'projects/p/locations/us-central1/queues/soundboard-research');
    vi.stubEnv('RESEARCH_TASK_URL', 'https://soundboard-1.us-central1.run.app/api/research/task');
    vi.stubEnv('RESEARCH_TASK_SA', 'research@p.iam.gserviceaccount.com');
    on(TASKS, () => json({}));
  });

  it('starts one run and enqueues its first delivery, then waits without a model call', async () => {
    const job = await unresearched({ consecutiveFailures: 1 });
    expect(await runStep(job)).toEqual({ wait: 'researching similar artists' });
    const [run] = await runs();
    expect(run).toMatchObject({
      stage: 'learn',
      seq: 0,
      ownerUid: USER_C.uid,
      artistId: USER_C.artistId,
    });
    expect(delivered()).toEqual([{ jobId: 'j1', uid: USER_C.uid, runId: run!.id, seq: 0 }]);
    expect(chatBodies()).toHaveLength(0);
    // A wait is never a failure: the streak and claim are as before.
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
    expect(await claimToken()).toBeNull();
  });

  it('only reads the run on later polls while it is running', async () => {
    const job = await unresearched();
    await runStep(job);
    expect(await runStep(job)).toEqual({ wait: 'researching similar artists' });
    expect(called(TASKS)).toHaveLength(1);
    expect(await runs()).toHaveLength(1);
  });

  it('goes ahead without the run 10 minutes after it started', async () => {
    await unresearched();
    await researched(C_JOB, {
      stage: 'match',
      startedAt: new Date(Date.now() - RESEARCH_MAX_MS),
      limits: ['analytics-not-shared'],
    });
    expect(await runStep(await saved())).toEqual({});
    expect(await saved()).toMatchObject({ state: 'REVIEW' });
    expect((await pickAt(1))?.researchRunId).toBe('run-1');
    expect(called(TASKS)).toHaveLength(0);
  });

  it('replaces a run that started 29 days ago', async () => {
    await unresearched();
    await researched(C_JOB, { startedAt: new Date(Date.now() - 29 * 24 * 60 * 60_000) });
    expect(await runStep(await saved())).toEqual({ wait: 'researching similar artists' });
    const [run] = await runs();
    expect(run).toMatchObject({ stage: 'learn', seq: 0 });
    expect(run!.id).not.toBe('run-1');
  });

  it('drafts without research when the queue refuses, and again after a re-run, never failing', async () => {
    on(TASKS, () => json({}, { status: 500 }));
    const job = await unresearched();
    expect(await runStep(job)).toEqual({});
    expect(await saved()).toMatchObject({ state: 'REVIEW', consecutiveFailures: 0 });
    const [first] = await runs();
    expect(first).toMatchObject({
      stage: 'failed',
      error: 'research-unavailable',
      limits: ['research-unavailable'],
    });
    expect((await pickAt(1))?.researchRunId).toBe(first!.id);

    await withIdentity(USER_C.uid, async () => rerun(await saved()));
    expect(await runs()).toEqual([]);
    // A new reply, since the skipped one would be asked again.
    const fresh = { ...RAW_PICK, title: 'Another take', description: 'A different line.' };
    on(GEMINI, () => interaction(JSON.stringify(fresh)));
    expect(await runStep(await saved())).toEqual({});
    expect(await saved()).toMatchObject({ state: 'REVIEW', consecutiveFailures: 0 });
    expect((await pickAt(2))?.researchRunId).not.toBe(first!.id);
    expect(called(TASKS)).toHaveLength(2);
  });

  it('keeps a failed run terminal: each poll goes on to the pick and enqueues nothing', async () => {
    await unresearched();
    await researched(C_JOB, { stage: 'failed', error: 'boom', limits: [] });
    on(GEMINI, () => busy429());
    expect(await runStep(await saved())).toEqual({ wait: 'model busy' });
    handlers.shift();
    expect(await runStep(await saved())).toEqual({});
    expect(await saved()).toMatchObject({ state: 'REVIEW' });
    expect(called(TASKS)).toHaveLength(0);
    expect((await runs())[0]).toMatchObject({ id: 'run-1', stage: 'failed' });
  });

  it('fails the run on an enqueue that spends the step, waits, and drafts on the next step', async () => {
    clock = NOON_PACIFIC;
    vi.spyOn(Date, 'now').mockImplementation(() => clock!);
    on(TASKS, () => {
      clock! += 106_000;
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    // Cached genre evidence, so the model's budget is the only thing the step still needs.
    await unresearched();
    await patchJob({ audience: AUDIENCE });
    expect(await runStep(await saved())).toEqual({ wait: 'model busy' });
    const [run] = await runs();
    expect(run).toMatchObject({ stage: 'failed', error: 'research-unavailable' });
    expect(chatBodies()).toHaveLength(0);
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 0 });

    // If the queue created the task after all, its delivery finds the run finished.
    expect(await runDelivery({ jobId: 'j1', uid: USER_C.uid, runId: run!.id, seq: 0 })).toBe(200);
    expect((await runs())[0]).toEqual(run);

    clock! += 1_000;
    expect(await runStep(await saved())).toEqual({});
    expect(await saved()).toMatchObject({ state: 'REVIEW' });
    expect(called(TASKS)).toHaveLength(1);
  });

  it('drafts on no genre evidence when the genre search hits the YouTube quota, storing none', async () => {
    await unresearched();
    await researched(C_JOB);
    on(/youtube\/v3\/search\?/, () => refusal(403, 'quotaExceeded'));
    expect(await runStep(await saved())).toEqual({});
    const job = await saved();
    expect(job).toMatchObject({ state: 'REVIEW', consecutiveFailures: 0, audience: null });
    expect(await db().select().from(jobAudience)).toEqual([]);
    const pick = (await pickAt(1))!;
    expect(pick.tags).toEqual([ARTIST_C.name]);
    expect(pick.hashtags).toEqual([]);
    // Research ended on its own limits; the genre search adds the one it lost.
    const limits = ['analytics-not-shared', 'no-peers', 'genre-search-unavailable'];
    expect(pick).toMatchObject({ limits, recommendation: { limits } });
  });

  describe('when the free sources fail', () => {
    // Google’s APIs, and YouTube’s thumbnail CDN.
    const GOOGLE = /(^|\.)(googleapis\.com|google\.com|ytimg\.com)$/;
    const hosts = () => [...new Set(calls.map(({ url }) => new URL(url).host))];
    /** The pick ends in a draft that names what it lacked, and the job never counts a failure. */
    const drafted = async () => {
      expect(await saved()).toMatchObject({ state: 'REVIEW', consecutiveFailures: 0, error: null });
      for (const host of hosts()) expect(host).toMatch(GOOGLE);
      return (await pickAt(1)) as { limits: string[]; recommendation: { limits: string[] } };
    };

    it('drafts after YouTube quota held the research at every stage, saying it did not finish', async () => {
      on(/youtube\/v3\/search\?/, () => refusal(403, 'quotaExceeded'));
      expect(await runStep(await unresearched())).toEqual({ wait: 'researching similar artists' });
      const [first] = await runs();
      // Learn has no analytics to read, so it moves on; discover then meets the quota.
      expect(await runDelivery({ jobId: 'j1', uid: USER_C.uid, runId: first!.id, seq: 0 })).toBe(
        200,
      );
      expect(await runDelivery({ jobId: 'j1', uid: USER_C.uid, runId: first!.id, seq: 1 })).toBe(
        200,
      );
      expect((await runs())[0]).toMatchObject({
        stage: 'discover',
        wait: 'waiting on YouTube',
        consecutiveFailures: 0,
        limits: ['analytics-not-shared'],
      });
      // Still waiting under 10 minutes.
      expect(await runStep(await saved())).toEqual({ wait: 'researching similar artists' });
      await db()
        .update(researchRuns)
        .set({ startedAt: new Date(Date.now() - RESEARCH_MAX_MS) });
      expect(await runStep(await saved())).toEqual({});
      const pick = await drafted();
      expect(pick.limits).toEqual([
        'analytics-not-shared',
        'research-unfinished',
        'genre-search-unavailable',
      ]);
      expect(pick.recommendation.limits).toEqual(pick.limits);
    });

    it('drafts from a failed run with the limits it ended on', async () => {
      await unresearched();
      await researched(C_JOB, { stage: 'failed', error: 'boom', limits: ['analytics-not-shared'] });
      expect(await runStep(await saved())).toEqual({});
      const pick = await drafted();
      expect(pick.limits).toEqual(['analytics-not-shared', 'research-unfinished']);
      expect(called(TASKS)).toHaveLength(0);
    });

    it('drafts when the queue is down, with the limit that says so', async () => {
      on(TASKS, () => json({}, { status: 503 }));
      expect(await runStep(await unresearched())).toEqual({});
      const pick = await drafted();
      expect(pick.limits).toEqual(['research-unavailable']);
      expect(called(TASKS)).toHaveLength(1);
    });

    it('drafts when the queue is down and the genre search is out of quota too', async () => {
      on(TASKS, () => json({}, { status: 503 }));
      on(/youtube\/v3\/search\?/, () => refusal(403, 'quotaExceeded'));
      expect(await runStep(await unresearched())).toEqual({});
      const pick = await drafted();
      expect(pick.limits).toEqual(['research-unavailable', 'genre-search-unavailable']);
      expect((await pickAt(1))!.tags).toEqual([ARTIST_C.name]);
    });
  });

  it('starts no run for a job whose owner has no profile', async () => {
    await unresearched({ ownerUid: 'uid-b', artistId: null });
    await runStep(await saved());
    expect(await runs()).toEqual([]);
    expect(called(TASKS)).toHaveLength(0);
  });
});

describe("runStep: PICK with Nathan's memory", () => {
  it("keeps Nathan's memory out of another artist's job and writes none of it", async () => {
    await seed({ artistMemory: [{ artistId: 'flr', kind: 'feedback', data: NATHAN_FEEDBACK }] });
    await runStep(await pickJob());
    expect((await saved()).state).toBe('REVIEW');
    const ctx = context();
    expect(ctx.feedback).toEqual([]);
    expect(ctx.facts.map((f) => f.key)).toEqual([ARTIST_NAME_KEY]);
    expect(await artistRowCount()).toBe(1);
  });

  it("waits for a profile once Nathan's job owner is unlinked, reading none of his memory", async () => {
    await seed({ artistMemory: [{ artistId: 'flr', kind: 'feedback', data: NATHAN_FEEDBACK }] });
    await approveGuide();
    await unlinkA();
    expect(await runStep(await pickJob(A_JOB))).toEqual({ wait: NO_ARTIST });
    expect(calls).toHaveLength(0);
    expect(await artistRowCount()).toBe(1);
  });

  it("runs a job not linked to the owner's profile without the profile's memory", async () => {
    await seed({
      artistMemory: [
        { artistId: ARTIST_C.id, kind: 'feedback', data: NATHAN_FEEDBACK },
        {
          artistId: ARTIST_C.id,
          kind: 'fact',
          key: 'home',
          data: { key: 'home', value: 'Ohio', kind: 'FACT', public: true },
        },
      ],
    });
    await runStep(await pickJob({ artistId: null }));
    expect((await saved()).state).toBe('REVIEW');
    const ctx = context();
    expect(ctx.artist).toBe(ARTIST_C.name);
    expect(ctx.feedback).toEqual([]);
    expect(ctx.facts.map((f) => f.key)).toEqual([ARTIST_NAME_KEY]);
  });

  it("uses Nathan's facts, feedback, cached candidates, and skipped versions", async () => {
    await seed({
      artistMemory: [
        { artistId: 'flr', kind: 'feedback', data: NATHAN_FEEDBACK },
        {
          artistId: 'flr',
          kind: 'fact',
          key: 'home',
          data: { key: 'home', value: 'Virginia', kind: 'FACT', public: true },
        },
        {
          artistId: 'flr',
          kind: 'fact',
          key: 'mr-kill',
          data: {
            key: 'mr-kill',
            value: 'Connected to Mr. Kill',
            kind: 'INFERENCE',
            public: false,
          },
        },
      ],
    });
    const job = await pickJob({
      ...A_JOB,
      hashtagCandidates: [SYNTHWAVE, RETROWAVE, '#newmusic'],
      audience: {
        retrievedAt: Date.now(),
        query: 'synthwave music video',
        candidateLists: [
          {
            source: 'genre',
            ref: 'G1',
            videoId: 'peer',
            title: 'Peer release',
            hashtags: [SYNTHWAVE, RETROWAVE, '#newmusic'],
            tags: [{ tag: 'synthwave' }, { tag: 'outrun' }],
          },
        ],
        top: [{ title: 'Top', description: 'd', tags: ['outrun'], views: 9 }],
      },
    });
    await db()
      .update(jobs)
      .set({
        picks: [
          {
            ...RAW_PICK,
            title: 'Old Title',
            description: 'An older description.',
            version: 1,
            skipped: true,
          },
          { ...RAW_PICK, title: 'Second', version: 2, skipped: false, modelMs: 50_000 },
        ],
      })
      .where(eq(jobs.id, 'j1'));
    await runStep(job);
    expect((await saved()).state).toBe('REVIEW');
    const third = (await pickAt(3)) as { version: number; modelMs: number };
    expect(third.version).toBe(3);
    // The stored time carries the earlier runs, so a re-run never drops them from the total.
    expect(third.modelMs).toBeGreaterThanOrEqual(50_000);
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(0);
    const ctx = context();
    expect(ctx.artist).toBe(ARTIST);
    expect(ctx.candidateLists).toEqual({
      G1: {
        videoId: 'peer',
        title: 'Peer release',
        hashtags: [SYNTHWAVE, RETROWAVE, '#newmusic'],
        tags: [{ tag: 'synthwave' }, { tag: 'outrun' }],
      },
    });
    expect(ctx.audienceTopVideos).toEqual([{ title: 'Top', description: 'd', tags: ['outrun'] }]);
    // The private INFERENCE is read but never reaches the prompt.
    expect(ctx.facts.map((f) => f.key)).toEqual([ARTIST_NAME_KEY, 'home']);
    expect(ctx.feedback).toHaveLength(1);
    expect(ctx.skippedVersions).toEqual([
      { title: 'Old Title', description: 'An older description.' },
    ]);
  });

  const GUIDE = { statement: 'Plain titles.', keep: ['Song only'], fix: [], drop: ['Emoji'] };
  const approveGuide = (artistId = 'flr', guide: BrandGuide = GUIDE) =>
    seed({ artistGuides: [approvedGuide(artistId, 'brand', guide)] });

  it("follows Nathan's approved brand guide", async () => {
    await approveGuide();
    await runStep(await pickJob(A_JOB));
    expect(context().brandGuide).toEqual(GUIDE);
  });

  it("keeps Nathan's brand guide out of another artist's job", async () => {
    await approveGuide();
    await runStep(await pickJob());
    expect(context()).not.toHaveProperty('brandGuide');
  });

  it("follows another artist's own approved brand guide", async () => {
    const own = { statement: 'Loud covers.', keep: [], fix: ['Titles'], drop: [] };
    await approveGuide(ARTIST_C.id, own);
    await runStep(await pickJob());
    expect(context().brandGuide).toEqual(own);
  });

  it("writes another artist's job in their own approved voice, never Nathan's", async () => {
    await seed({
      artistGuides: [approvedGuide(ARTIST_C.id, 'voice', { rules: ['Lowercase everything.'] })],
    });
    await runStep(await pickJob(C_JOB));
    expect(rules()).toContain('- Lowercase everything.');
    expect(rules()).not.toContain('hacked and slashed');
    expect(rules()).not.toContain('Write the description in plain words:');
  });

  it('leaves every stored job byte for byte when a guide is approved later', async () => {
    await runStep(await pickJob(A_JOB));
    const before = await db().select().from(jobs);
    await approveGuide();
    await seed({ artistGuides: [approvedGuide(ARTIST_C.id, 'voice', { rules: ['New.'] })] });
    expect(await db().select().from(jobs)).toEqual(before);
  });

  it('counts an unparseable recommendation as a failure', async () => {
    on(GEMINI, () => interaction(BAD_PICK_JSON));
    await runStep(await pickJob());
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
    expect((await saved()).error).toBe('The model reply did not parse as a recommendation.');
    expect(await pickAt(1)).toBeUndefined();
  });

  it('reports the original model error to Sentry, not the evidence-carrying wrapper', async () => {
    captureException.mockClear();
    on(GEMINI, () => interaction(BAD_PICK_JSON));
    await runStep(await pickJob());
    expect(captureException).toHaveBeenCalledTimes(1);
    const [reported, context] = captureException.mock.calls[0]!;
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).constructor.name).toBe('Error');
    expect((reported as Error).message).toBe('The model reply did not parse as a recommendation.');
    expect(context).toEqual({ tags: { step: 'PICK' } });
  });

  it('keeps the genre search when the model fails, so the retry does not search again', async () => {
    on(GEMINI, () => interaction(BAD_PICK_JSON));
    await runStep(await pickJob());
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(1);
    expect((await saved()).audience?.candidateLists.flatMap((list) => list.hashtags)).toEqual([
      SYNTHWAVE,
      RETROWAVE,
      '#newmusic',
    ]);

    on(GEMINI, () => interaction(JSON.stringify(RAW_PICK)));
    await runStep(await saved());
    expect(await saved()).toMatchObject({ state: 'REVIEW', consecutiveFailures: 0 });
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(1);
  });
});

describe('runStep: model waits', () => {
  const MODEL_BUSY = 'model busy';
  const QUOTA_SPENT = 'model quota spent';
  /** The second of two windows, with the first already analyzed. */
  const analyzeJob = async (patch: Partial<JobDoc> = {}) => {
    const job = await put({
      state: 'ANALYZE',
      probe: PROBE_100,
      chunkCount: 2,
      chunkIndex: 1,
      ...patch,
    });
    await setChunks('j1', [{ index: 0 }]);
    return job;
  };
  const hookJob = async (patch: Partial<JobDoc> = {}) => {
    await put({ id: 'p1', state: 'REVIEW' });
    return put({ id: 'h1', state: 'HOOK', parentId: 'p1', sourceObject: SOURCE_OBJECT, ...patch });
  };

  it.each([
    ['a per-minute 429', busy429],
    ['a 503', unavailable503],
  ])('waits on %s during analyze, keeping finished chunks and the streak', async (_, reply) => {
    on(GEMINI, () => reply());
    const job = await analyzeJob({ consecutiveFailures: 1, error: 'earlier' });
    expect(await runStep(job)).toEqual({ wait: MODEL_BUSY });
    expect(await saved()).toMatchObject({
      state: 'ANALYZE',
      chunkIndex: 1,
      consecutiveFailures: 1,
      error: 'earlier',
      limitUntil: null,
    });
    expect((await arrays()).chunks).toEqual([{ index: 0 }]);
    expect(existsSync(clipPaths()[0]!)).toBe(false);
    expect(captureException).not.toHaveBeenCalled();
    expect(await claimToken()).toBeNull();
  });

  it('continues once the model answers again', async () => {
    on(GEMINI, () => busy429());
    await runStep(await analyzeJob());
    handlers.shift();
    expect(await runStep(await saved())).toEqual({});
    expect(await saved()).toMatchObject({ state: 'PICK', chunkIndex: 2 });
  });

  it('waits on a busy pick and keeps the genre search, so the retry does not search again', async () => {
    on(GEMINI, () => busy429());
    expect(await runStep(await pickJob({ consecutiveFailures: 1 }))).toEqual({ wait: MODEL_BUSY });
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
    expect((await saved()).audience?.candidateLists).toHaveLength(1);
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(1);
    handlers.shift();
    await runStep(await saved());
    expect(await saved()).toMatchObject({ state: 'REVIEW', consecutiveFailures: 0 });
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(1);
  });

  it('holds a spent per-day quota until the Pacific midnight reset, with no media or model call', async () => {
    vi.setSystemTime(NOON_PACIFIC);
    on(GEMINI, () => perDay429());
    expect(await runStep(await analyzeJob())).toEqual({ wait: QUOTA_SPENT });
    expect(await saved()).toMatchObject({
      state: 'ANALYZE',
      consecutiveFailures: 0,
      limitUntil: quotaResetAt(NOON_PACIFIC),
    });
    expect(captureException).not.toHaveBeenCalled();

    h.spawn.mockClear();
    calls.length = 0;
    expect(await runStep(await saved())).toEqual({ wait: QUOTA_SPENT });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(await claimToken()).toBeNull();
  });

  it('holds pick and hook before any catalog, search or model call', async () => {
    const until = Date.now() + 60_000;
    expect(await runStep(await pickJob({ limitUntil: until }))).toEqual({ wait: QUOTA_SPENT });
    expect(await runStep(await hookJob({ limitUntil: until }))).toEqual({
      wait: QUOTA_SPENT,
    });
    expect(calls).toHaveLength(0);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['analyze', analyzeJob, 'PICK'],
    ['pick', pickJob, 'REVIEW'],
  ] as const)('clears a passed limit once the %s answers', async (_, seed, next) => {
    await runStep(await seed({ limitUntil: Date.now() - 1 }));
    expect(await saved()).toMatchObject({ state: next, limitUntil: null });
  });

  it.each([400, 403, 500])('counts a Gemini %i toward the two-strike failure', async (status) => {
    on(GEMINI, () => geminiError(status, 'ERROR'));
    await runStep(await pickJob());
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
    expect((await saved()).error).toMatch(`Gemini ${status}: `);
    await runStep(await saved());
    expect(await saved()).toMatchObject({ state: 'FAILED', failedState: 'PICK' });
    expect(captureException).toHaveBeenCalledTimes(2);
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

  it('waits to reconnect when the grant no longer decrypts, without a strike or YouTube call', async () => {
    await db()
      .update(connections)
      .set({ tokenCiphertext: 'sealed-under-another-key' })
      .where(eq(connections.uid, USER_A.uid));
    expect(await runStep(await publishing())).toEqual({ wait: RECONNECT });
    expect(await connectionOf(USER_A.uid)).toMatchObject({ status: 'revoked' });
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      consecutiveFailures: 0,
      error: null,
      uploadStartedAt: null,
    });
    expect(calls).toHaveLength(0);
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

  it.each(['PUBLISHING', 'CLAIMED_COMPLETE'] as const)(
    'waits on YouTube when the refresh stalls to the deadline in %s, counting no failure',
    async (state) => {
      h.refreshError = Object.assign(new Error('The operation was aborted.'), {
        name: 'AbortError',
      });
      const job = await publishing({ state, videoId: state === 'PUBLISHING' ? null : 'vid1' });
      expect(await runStep(job)).toEqual({ wait: WAITING_ON_YOUTUBE });
      expect(await saved()).toMatchObject({ state, consecutiveFailures: 0, error: null });
      expect(await connectionOf(A_JOB.ownerUid)).toMatchObject({ status: 'connected' });
      expect(called(/youtube/)).toHaveLength(0);
    },
  );

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

  it('sends no initiation request when the job disappears before its durable marker', async () => {
    const job = await publishing();
    await vanishOnUpdate();

    await withIdentity(USER_A.uid, () => runStep(job));

    expect(called(/upload\/youtube\/v3\/videos/)).toHaveLength(0);
    expect(await db().select().from(jobs)).toEqual([]);
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

  it('cancels the source and sends no final bytes when the owner is revoked mid-step', async () => {
    let cancelled = false;
    on(/storage\.googleapis\.com/, async () => {
      await db().update(users).set({ active: false }).where(eq(users.uid, USER_A.uid));
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 206 },
      );
    });
    const job = await publishing({ upload: UPLOAD });

    await withIdentity(USER_A.uid, () => runStep(job));

    expect(cancelled).toBe(true);
    const uploadCalls = called(/upload\.example\/s1/);
    expect(uploadCalls).toHaveLength(1);
    expect(headers(uploadCalls[0]!.init)['content-range']).toBe('bytes */1000');
    expect(await saved()).toMatchObject({
      state: 'PUBLISHING',
      finalChunkAt: null,
      upload: UPLOAD,
    });
  });

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
  const publishes = () => artistRows('publish');

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

  describe('adoption', () => {
    const PICK = {
      ...RAW_PICK,
      version: 1,
      skipped: false,
      title: 'Proposed',
      description: 'Proposed description.',
      tags: ['synthwave'],
      hashtags: [],
      artistName: ARTIST,
      modelMs: 1,
      flags: [],
      influence: { sound: 1, feel: 0, wording: 0, discovery: 4, structure: 4 },
      recommendation: {
        approach: 'Open on the hook.',
        intendedOutcome: 'More listeners stay.',
        follows: 'peers',
        followsWhy: 'P1 does.',
        evidence: ['P1'],
        limits: ['no-peers'],
      },
    };
    const withPick = async (final: typeof FIELDS, patch: Partial<JobDoc> = {}) => {
      await claimed({ pickVersion: 1, finalFields: final, ...patch });
      await db()
        .update(jobs)
        .set({ picks: [PICK] })
        .where(eq(jobs.id, 'j1'));
      await runStep(await saved());
      return (await publishes())[0]!.data;
    };
    const same = {
      ...FIELDS,
      title: 'Proposed',
      description: 'Proposed description.',
      tags: ['synthwave'],
    };

    it('records what was suggested as refs only, the settings used, and that it was kept as is', async () => {
      expect(await withPick(same)).toMatchObject({
        recommendation: {
          approach: 'Open on the hook.',
          intendedOutcome: 'More listeners stay.',
          evidence: ['P1'],
        },
        influence: PICK.influence,
        editedBeforeApproval: false,
      });
      expect(JSON.stringify((await publishes())[0]!.data)).not.toContain('no-peers');
    });

    it.each([
      ['title', { title: 'Mine' }],
      ['description', { description: 'Mine.' }],
      ['tags', { tags: ['synthwave', 'outrun'] }],
    ])('flags an approval that changed the %s', async (_field, change) => {
      expect(await withPick({ ...same, ...change })).toMatchObject({ editedBeforeApproval: true });
    });

    it('records no suggestion for a Short, whose pick is its parent’s approved text', async () => {
      await put({ id: 'p1', ...A_JOB, state: 'VERIFIED' });
      expect(await withPick(same, { parentId: 'p1' })).toMatchObject({
        recommendation: null,
        influence: null,
        editedBeforeApproval: false,
      });
    });

    it('records no suggestion when the pick had none', async () => {
      await claimed({ pickVersion: 1, finalFields: same });
      await db()
        .update(jobs)
        .set({ picks: [{ ...PICK, recommendation: null }] })
        .where(eq(jobs.id, 'j1'));
      await runStep(await saved());
      expect((await publishes())[0]!.data).toMatchObject({ recommendation: null });
    });
  });

  it("verifies a job outside Nathan's artist without touching the artist tables", async () => {
    await runStep(await claimed({ artistId: null }));
    expect((await saved()).state).toBe('VERIFIED');
    expect(await artistRowCount()).toBe(0);
  });

  it('records no publish when the job is discarded while the read-back is in flight', async () => {
    on(/com\/youtube\/v3\/videos\?/, async () => {
      await discard((await getJob('j1'))!);
      return json({ items: [{ id: 'vid1', status: { uploadStatus: 'processed' } }] });
    });
    await runStep(await claimed());
    expect((await saved()).state).toBe('DISCARDED');
    expect(await publishes()).toEqual([]);
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

  it('drops the step result when the job was discarded mid-step', async () => {
    const job = await pickJob();
    on(GEMINI, async () => {
      await patchJob({ state: 'DISCARDED' });
      return interaction(JSON.stringify(RAW_PICK));
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
  const hookReply = (hook: unknown) => on(GEMINI, () => interaction(JSON.stringify(hook)));

  const loudLines = (from: number, to: number, at: number) => {
    const lines: string[] = [];
    for (let t = 0.1; from + t <= to + 1e-9; t = Math.round((t + 0.1) * 10) / 10) {
      lines.push(`t: ${t}  TARGET:-23 LUFS    M: ${from + t <= at ? -40 : -12} S: -20`);
    }
    return lines.join('\n');
  };

  beforeEach(async () => {
    await put({ id: 'p1', state: 'REVIEW', chunkCount: 3 });
    await setChunks(
      'p1',
      Array.from({ length: 3 }, (_, i) => ({
        index: i,
        startSec: i * 60,
        durationSec: 60,
        measurements: MEASURED,
        analysis: ANALYSIS,
        raw: null,
        modelMs: 1,
      })),
    );
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
      return child({ stderr: loudLines(57, 122, 70) });
    });
  });

  it('runs HOOK then RENDER into REVIEW, one step per call', async () => {
    hookReply({ window: 1, lengthSec: 30, reason: 'The chorus lands.' });
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
      window: 1,
      startSec: 70,
      lengthSec: 30,
      reason: 'The chorus lands.',
    });
    expect(JSON.stringify(chatBodies().at(-1)!.response_format)).toContain(
      JSON.stringify(HOOK_SCHEMA),
    );

    expect(await runStep(await saved())).toEqual({});
    expect(await saved()).toMatchObject({
      state: 'REVIEW',
      object: 'uploads/j1-1',
      probe: { width: 1080, height: 1920 },
      short: { renders: 1 },
    });
  });

  it('fails at HOOK after two unparsed replies in a row, ready for a retry', async () => {
    on(GEMINI, () => interaction('nope'));
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
    on(GEMINI, () => interaction(JSON.stringify({ window: 2, lengthSec: 30, reason: 'x' })));
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
    expect(called(GEMINI)).toHaveLength(2);
  });

  it('fails the render when the upload to storage is refused', async () => {
    h.upload.mockRejectedValue(new Error('403 Forbidden'));
    const hook = { window: 1, startSec: 70, lengthSec: 30, reason: 'x' };
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

describe('runStep: PICK with peers and the artist’s results', () => {
  const ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';
  const RETRIEVED = new Date(Date.now() - 24 * 60 * 60_000);
  const CITED = {
    sound: ['analysis', 'P1'],
    feel: ['voice'],
    wording: ['voice'],
    discovery: ['P1-R1', 'G1'],
    structure: ['P1-R1', 'identity'],
  };
  // Under the owner's identity, so the database applies its row-level rules to what the pick reads.
  const step = (job: JobDoc) => withIdentity(USER_C.uid, () => runStep(job));
  const reply = (over: Record<string, unknown> = {}) =>
    on(GEMINI, () =>
      interaction(
        JSON.stringify({
          ...RAW_PICK,
          citations: CITED,
          recommendation: {
            ...RAW_PICK.recommendation,
            follows: 'peers',
            evidence: ['P1', 'P1-R1'],
          },
          ...over,
        }),
      ),
    );
  const stored = (run = 'run-1') => ({
    runId: run,
    jobId: 'j1',
    retrievedAt: RETRIEVED,
    evidence: evidence(),
  });
  /** A PICK job for C with a finished run and its stored evidence. */
  const withPeers = async (limits: string[] = ['analytics-not-shared']) => {
    const job = await put({ state: 'PICK', ...C_JOB });
    await setChunks('j1', [0, 1].map(chunkDoc));
    await researched(job, { limits });
    await seed({ jobResearch: [stored()] });
    return job;
  };
  const shareAnalytics = () =>
    db()
      .update(connections)
      .set({ scopes: ['openid', 'email', ANALYTICS] })
      .where(eq(connections.uid, USER_C.uid));
  const outcomeRow = (videoId: string, over = {}) => ({
    artistId: ARTIST_C.id,
    videoId,
    retrievedAt: new Date(),
    publishedAt: new Date('2026-09-01T00:00:00Z'),
    requestedStart: '2026-09-01',
    requestedEnd: '2026-09-28',
    coverage: 'complete' as const,
    metrics: { views: 900, subscribersGained: 12, subscribersLost: 2 },
    live: { title: 'Last Light', description: 'Live copy.', tags: ['synthwave'] },
    differsFromApproved: false,
    ...over,
  });

  it('puts the run’s peers and releases in the prompt and stores what the pick cited', async () => {
    reply();
    await step(await withPeers());
    const pick = (await pickAt(1))!;
    expect(pick).toMatchObject({
      researchRunId: 'run-1',
      evidenceExpiresAt: new Date(RETRIEVED.getTime() + 29 * 24 * 60 * 60_000).toISOString(),
      influence: { sound: 1, feel: 0, wording: 0, discovery: 4, structure: 4 },
      citations: CITED,
      influenceWarning: null,
      recommendation: { evidence: ['P1', 'P1-R1'], limits: ['analytics-not-shared'] },
      limits: ['analytics-not-shared'],
    });
    const ctx = context();
    expect(Object.keys(ctx.similarArtists!)).toEqual(['P1', 'P2', 'P3']);
    expect(Object.keys(ctx.candidateLists)).toEqual(['G1', 'P1-R1', 'P2-R1', 'P3-R1']);
    expect(ctx.audienceTopVideos).toBeUndefined();
  });

  it('keeps every peer name and channel ID out of the stored pick and the artist memory', async () => {
    reply({
      recommendation: {
        ...RAW_PICK.recommendation,
        approach: `Open the way ${PEER_TITLE} does.`,
        evidence: ['P1'],
      },
    });
    await step(await withPeers());
    const stored = JSON.stringify([await arrays(), await db().select().from(artistMemory)]);
    expect(stored).not.toContain(PEER_TITLE);
    expect(stored).not.toContain('UC-peer');
    expect((await pickAt(1))!.recommendation).toMatchObject({ approach: 'Open the way P1 does.' });
  });

  it('drops a rejected channel’s peer, its releases and its candidate lists from the prompt', async () => {
    reply();
    await withPeers();
    await seed({
      peerRejections: [{ artistId: ARTIST_C.id, channelId: 'UC-peer-2', retrievedAt: new Date() }],
    });
    await step(await saved());
    const ctx = context();
    expect(Object.keys(ctx.similarArtists!)).toEqual(['P1', 'P3']);
    expect(Object.keys(ctx.candidateLists)).toEqual(['G1', 'P1-R1', 'P3-R1']);
  });

  it('drafts without peers once the evidence is gone, saying only what the run said', async () => {
    reply();
    const job = await put({ state: 'PICK', ...C_JOB });
    await setChunks('j1', [0, 1].map(chunkDoc));
    await researched(job, { limits: ['no-peers'] });
    await step(await saved());
    const pick = (await pickAt(1))!;
    expect(pick).toMatchObject({ researchRunId: 'run-1', evidenceExpiresAt: null });
    expect(context().similarArtists).toBeUndefined();
    expect(pick.limits).toEqual(['no-peers']);
  });

  it('uses the settings saved on the approved brand guide, and records them on the pick', async () => {
    const influence = { sound: 0, feel: 4, wording: 4, discovery: 2, structure: 0 };
    reply({
      citations: {
        sound: ['analysis'],
        feel: ['P1', 'P2'],
        wording: ['P1', 'P2'],
        discovery: ['P1-R1', 'G1'],
        structure: ['identity'],
      },
    });
    await seed({
      artistGuides: [
        approvedGuide(ARTIST_C.id, 'brand', { statement: 'Plain.', keep: [], fix: [], drop: [] }),
      ],
    });
    await db().update(artistGuides).set({ influence }).where(eq(artistGuides.kind, 'brand'));
    await step(await withPeers());
    expect((await pickAt(1))!.influence).toEqual(influence);
    expect(
      chatBodies().at(-1)!.system_instruction ?? JSON.stringify(chatBodies().at(-1)),
    ).toContain('- feel (level 4 of 4)');
  });

  it('leaves an earlier pick alone when the defaults or settings change later', async () => {
    reply();
    await seed({
      artistGuides: [
        approvedGuide(ARTIST_C.id, 'brand', { statement: 'Plain.', keep: [], fix: [], drop: [] }),
      ],
    });
    await step(await withPeers());
    const before = await pickAt(1);
    await db()
      .update(artistGuides)
      .set({ influence: { sound: 4, feel: 4, wording: 4, discovery: 4, structure: 4 } })
      .where(eq(artistGuides.kind, 'brand'));
    expect(await pickAt(1)).toEqual(before);
  });

  it('re-asks once for a missed level and keeps the draft with a warning', async () => {
    reply({ citations: { ...CITED, sound: ['analysis'] } });
    await step(await withPeers());
    expect(called(GEMINI)).toHaveLength(2);
    expect(await saved()).toMatchObject({ state: 'REVIEW' });
    expect((await pickAt(1))!.influenceWarning).toBe('Influence settings not met');
  });

  it('spends one re-ask on a copy and a missed level together: two provider calls', async () => {
    reply({
      description: `Made in ${COPIED}.`,
      citations: { ...CITED, sound: ['analysis'] },
    });
    await step(await withPeers());
    expect(called(GEMINI)).toHaveLength(2);
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
  });

  it('fails the step, keeping the genre search, when a copy survives the re-ask', async () => {
    reply({ description: `Made in ${COPIED}.` });
    await step(await withPeers());
    expect(called(GEMINI)).toHaveLength(2);
    const job = await saved();
    expect(job).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
    expect(job.error).toBe("The draft copied a similar artist's wording. Try again.");
    expect(job.audience).not.toBeNull();
    expect(await pickAt(1)).toBeUndefined();
  });

  it('counts a parse failure and then a copy as two calls and a step failure', async () => {
    let n = 0;
    on(GEMINI, () =>
      interaction(
        n++ === 0
          ? BAD_PICK_JSON
          : JSON.stringify({ ...RAW_PICK, citations: CITED, description: `Made in ${COPIED}.` }),
      ),
    );
    await step(await withPeers());
    expect(called(GEMINI)).toHaveLength(2);
    expect(await saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
  });

  it('drops a recommendation that only secondary artists support, with the limit', async () => {
    reply({ recommendation: { ...RAW_PICK.recommendation, evidence: ['P3'] } });
    await step(await withPeers());
    expect(called(GEMINI)).toHaveLength(2);
    expect(await pickAt(1)).toMatchObject({
      recommendation: null,
      limits: ['analytics-not-shared', 'secondary-only'],
    });
  });

  it('removes a sentinel statistic from every stored field, feedback and publish record included', async () => {
    const stat = 'It earned 987654 views.';
    reply({
      title: `Title ${stat}`,
      description: `Desc. ${stat}`,
      brandCheck: `Brand. ${stat}`,
      why: { title: `a. ${stat}`, description: `b. ${stat}`, tags: `c. ${stat}` },
      bandcamp: { about: `About. ${stat}`, credits: `Credits. ${stat}` },
      recommendation: {
        ...RAW_PICK.recommendation,
        evidence: ['P1'],
        followsWhy: `Because. ${stat}`,
      },
    });
    await step(await withPeers());
    expect(JSON.stringify(await arrays())).not.toContain('987654');
    expect(JSON.stringify(await db().select().from(artistMemory))).not.toContain('987654');
  });

  describe('the artist’s own results', () => {
    it('adds each fresh result as A<n> with its suggestion and what was published', async () => {
      reply({ recommendation: { ...RAW_PICK.recommendation, evidence: ['A1', 'P1'] } });
      await shareAnalytics();
      await seed({
        artistOutcomes: [outcomeRow('own-1', { differsFromApproved: true })],
        artistMemory: [
          {
            artistId: ARTIST_C.id,
            kind: 'publish',
            key: 'own-1',
            data: {
              videoId: 'own-1',
              url: 'https://youtu.be/own-1',
              jobId: 'old',
              fields: {
                title: 'Approved',
                description: 'Approved copy.',
                hashtags: [],
                tags: ['x'],
              },
              status: 'VERIFIED',
              at: 1,
              recommendation: {
                approach: 'Try short titles.',
                intendedOutcome: 'More clicks.',
                evidence: ['P1'],
              },
              influence: null,
              editedBeforeApproval: true,
            },
          },
        ],
      });
      await step(await withPeers());
      const result = context().artistResults!.A1 as Record<string, unknown>;
      expect(result).toMatchObject({
        suggested: { approach: 'Try short titles.', intendedOutcome: 'More clicks.' },
        published: { title: 'Approved' },
        editedBeforeApproval: true,
        changedOnYouTubeSinceApproval: true,
        coverage: 'complete',
        netSubscribers: { value: 10, calculated: true },
      });
      expect(await pickAt(1)).toMatchObject({ outcomeRefs: { A1: 'own-1' } });
    });

    it('shows a result nobody suggested as unsuggested, and missing metrics as null', async () => {
      reply();
      await shareAnalytics();
      await seed({
        artistOutcomes: [
          outcomeRow('own-2', {
            coverage: 'unknown',
            metrics: { views: null, subscribersGained: null, subscribersLost: null },
          }),
        ],
      });
      await step(await withPeers());
      const result = context().artistResults!.A1 as Record<string, unknown>;
      expect(result).toMatchObject({ suggested: null, published: null, coverage: 'unknown' });
      expect((result.reportedByYouTube as { views: unknown }).views).toBeNull();
      expect(result.netSubscribers).toEqual({ value: null, calculated: true });
    });

    it('shows no results once analytics is not shared', async () => {
      reply();
      await seed({ artistOutcomes: [outcomeRow('own-3')] }).catch(() => undefined);
      await step(await withPeers());
      expect(context().artistResults).toBeUndefined();
      expect(await pickAt(1)).toMatchObject({ outcomeRefs: {} });
    });
  });
});

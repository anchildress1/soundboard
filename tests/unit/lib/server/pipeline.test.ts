// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../helpers/fake-firestore';
import { captureException } from '../../../mocks/sentry';
import { resetClients } from '$lib/server/clients';
import { MAX_MINUTES, type JobDoc } from '$lib/server/jobs';
import { failurePatch, runStep, VERIFY_ATTEMPTS } from '$lib/server/pipeline';
import { clearStatsCache } from '$lib/server/youtube';

type Run = { stdout?: string | Buffer; stderr?: string; fd3?: Buffer; code?: number };

const h = vi.hoisted(() => ({
  objects: new Map<string, { size?: string; contentType?: string }>(),
  secrets: new Map<string, string>(),
  spawn: vi.fn(),
}));

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      return {
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

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    async accessSecretVersion({ name }: { name: string }) {
      const value = h.secrets.get(name.split('/')[3]!);
      if (value === undefined) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
      return [{ payload: { data: Buffer.from(value) } }];
    }
  },
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    setCredentials() {}
    async getAccessToken() {
      return { token: 'access-1' };
    }
  },
}));

vi.mock('node:child_process', () => ({ spawn: h.spawn }));

// ---- ffmpeg / ffprobe ----

const MEASURE_STDERR = [
  '[Parsed_ebur128_0 @ 0x1] Summary:',
  '  Integrated loudness:',
  '    I:         -13.8 LUFS',
  '  True peak:',
  '    Peak:        -0.4 dBFS',
  '[Parsed_astats_2 @ 0x2] Peak level dB: -2.1',
  '[Parsed_astats_2 @ 0x2] Peak count: 4',
  '[silencedetect @ 0x3] silence_start: 80',
  '[silencedetect @ 0x3] silence_end: 83 | silence_duration: 3',
].join('\n');

const probeJson = (durationSec: number, audio = true) =>
  JSON.stringify({
    format: { duration: String(durationSec) },
    streams: [
      { codec_type: 'video', width: 1920, height: 1080 },
      ...(audio ? [{ codec_type: 'audio' }] : []),
    ],
  });

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0xff, 0xd9]);

let tools: { probe: Run; measure: Run; window: Run };

function child(run: Run) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const fd3 = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdio: [null, stdout, stderr, fd3],
  });
  setImmediate(() => {
    if (run.stdout) stdout.emit('data', Buffer.from(run.stdout));
    if (run.stderr) stderr.emit('data', Buffer.from(run.stderr));
    if (run.fd3) fd3.emit('data', run.fd3);
    proc.emit('close', run.code ?? 0);
  });
  return proc;
}

// ---- network: llama-server, YouTube, GCS signed URLs ----

const ANALYSIS = {
  visual: 'Neon city streets at night, quick cuts.',
  music: {
    genre: ['synthwave', 'electronic'],
    tempoFeel: 'driving',
    instrumentation: ['analog synth', 'drum machine'],
    vocals: 'male lead',
    mood: ['nostalgic'],
  },
  qualityFlags: [],
};

const RAW_PICK = {
  title: 'PeekaBoo (Official Video)',
  description: 'A night drive through the city. #synthwave',
  hashtags: ['#synthwave', '#retrowave', '#newmusic'],
  tags: ['synthwave', 'PeekaBoo', 'Flies Like Robots'],
  flags: [],
  brandCheck: 'Keeps the channel naming pattern.',
  why: { title: 'Matches recent titles.', description: 'Short and plain.', tags: 'Genre first.' },
  bandcamp: { about: 'Bandcamp about.', credits: 'Written by Nathan.' },
};

type Handler = {
  test: RegExp;
  reply: (url: string, init: RequestInit) => Response | Promise<Response>;
};

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

let handlers: Handler[];
const calls: { url: string; init: RequestInit }[] = [];

/** Later registrations win over the defaults. */
const on = (test: RegExp, reply: Handler['reply']) => handlers.unshift({ test, reply });
const called = (test: RegExp) => calls.filter((c) => test.test(c.url));
const headers = (init: RequestInit) => (init.headers ?? {}) as Record<string, string>;
const chatBodies = () =>
  called(/\/v1\/chat\/completions$/).map(
    (c) => JSON.parse(String(c.init.body)) as Record<string, unknown>,
  );

const completion = (content: string) =>
  json({
    choices: [{ message: { content, reasoning_content: 'thinking' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

function defaultHandlers(): Handler[] {
  return [
    { test: /127\.0\.0\.1:8081\/health$/, reply: () => json({ status: 'ok' }) },
    { test: /127\.0\.0\.1:8081\/slots$/, reply: () => json([{ is_processing: false }]) },
    {
      test: /127\.0\.0\.1:8081\/v1\/chat\/completions$/,
      reply: (_url, init) => {
        const body = JSON.parse(String(init.body)) as {
          response_format: { json_schema: { name: string } };
        };
        const name = body.response_format.json_schema.name;
        return completion(JSON.stringify(name === 'chunk_analysis' ? ANALYSIS : RAW_PICK));
      },
    },
    {
      test: /youtube\/v3\/channels\?/,
      reply: () =>
        json({
          items: [
            {
              snippet: { customUrl: '@flieslikerobots' },
              statistics: { videoCount: '12', subscriberCount: '300' },
              contentDetails: { relatedPlaylists: { uploads: 'UUflr' } },
            },
          ],
        }),
    },
    {
      test: /youtube\/v3\/playlistItems\?/,
      reply: () =>
        json({
          items: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'].map((videoId) => ({
            contentDetails: { videoId, videoPublishedAt: '2026-09-01T00:00:00Z' },
          })),
        }),
    },
    {
      test: /com\/youtube\/v3\/videos\?/,
      reply: (url, init) => {
        const id = new URL(url).searchParams.get('id') ?? '';
        if (headers(init).authorization) {
          return json({
            items: [{ id, snippet: { title: 't' }, status: { uploadStatus: 'processed' } }],
          });
        }
        return json({
          items: id.split(',').map((vid, i) => ({
            id: vid,
            snippet: {
              title: `Song ${vid}`,
              description: `Out now. #synthwave #retrowave${i === 0 ? ' #newmusic' : ''}`,
              tags: ['synthwave'],
              publishedAt: '2026-09-01T00:00:00Z',
              thumbnails:
                vid === 'v5' ? {} : { medium: { url: `https://i.ytimg.com/${vid}/m.jpg` } },
            },
          })),
        });
      },
    },
    { test: /youtube\/v3\/search\?/, reply: () => json({ items: [{ id: { videoId: 's1' } }] }) },
    {
      test: /i\.ytimg\.com/,
      reply: () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } }),
    },
    {
      test: /upload\/youtube\/v3\/videos/,
      reply: () =>
        new Response('', { status: 200, headers: { location: 'https://upload.example/s1' } }),
    },
    {
      test: /upload\.example\/s1/,
      reply: (_url, init) =>
        headers(init)['content-range']?.startsWith('bytes */')
          ? new Response('', { status: 308 })
          : json({ id: 'vid1' }),
    },
    { test: /storage\.googleapis\.com/, reply: () => new Response('xx', { status: 206 }) },
  ];
}

// ---- jobs ----

function jobDoc(patch: Partial<JobDoc> = {}): JobDoc {
  return {
    id: 'j1',
    state: 'PREP',
    owner: 'visitor',
    channel: null,
    songTitle: 'PeekaBoo',
    notes: '',
    filename: 'peekaboo.mp4',
    contentType: 'video/mp4',
    sampleId: null,
    liveVideoId: null,
    object: 'uploads/j1',
    ipHash: null,
    probe: null,
    measurements: null,
    chunkCount: 0,
    chunkIndex: 0,
    failedState: null,
    error: null,
    uploadProgress: null,
    videoId: null,
    payload: null,
    consecutiveFailures: 0,
    claim: null,
    trace: null,
    hashtagCandidates: null,
    audience: null,
    upload: null,
    finalFields: null,
    pickVersion: null,
    verifyAttempts: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function seed(patch: Partial<JobDoc> = {}): JobDoc {
  const doc = jobDoc(patch);
  store.set(`jobs/${doc.id}`, structuredClone(doc));
  return doc;
}

const saved = () => store.get('jobs/j1') as JobDoc;
const FIELDS = {
  title: 'PeekaBoo',
  description: 'd #synthwave',
  hashtags: ['#synthwave'],
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

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  vi.stubEnv('YOUTUBE_API_KEY', 'key');
  vi.stubEnv('FLR_CHANNEL_ID', 'UCflr');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'secret');
  resetStore();
  resetClients();
  clearStatsCache();
  h.objects.clear();
  h.objects.set('uploads/j1', { size: '1000', contentType: 'video/quicktime' });
  h.secrets.clear();
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('runStep: AWAITING_UPLOAD', () => {
  it('moves to PREP once the browser upload lands', async () => {
    expect(await runStep(seed({ state: 'AWAITING_UPLOAD' }))).toEqual({});
    expect(saved().state).toBe('PREP');
  });

  it('keeps waiting while the object is missing', async () => {
    h.objects.clear();
    expect(await runStep(seed({ state: 'AWAITING_UPLOAD' }))).toEqual({});
    expect(saved().state).toBe('AWAITING_UPLOAD');
  });
});

describe('runStep: states the page does not drive', () => {
  it.each(['REVIEW', 'VERIFIED', 'PAYLOAD', 'FAILED', 'DISCARDED'] as const)(
    'leaves %s untouched',
    async (state) => {
      expect(await runStep(seed({ state }))).toEqual({});
      expect(saved().state).toBe(state);
      expect(saved().claim).toBeNull();
      expect(calls).toHaveLength(0);
      expect(h.spawn).not.toHaveBeenCalled();
    },
  );
});

describe('runStep: model readiness', () => {
  it('returns "waking model" while /health answers 503, without claiming the job', async () => {
    on(/\/health$/, () => new Response('loading', { status: 503 }));
    const result = await runStep(seed({ state: 'ANALYZE', probe: PROBE, chunkCount: 2 }));
    expect(result).toEqual({ wait: 'waking model' });
    expect(saved().claim).toBeNull();
    expect(saved().consecutiveFailures).toBe(0);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('treats a refused connection as loading', async () => {
    on(/\/health$/, () => Promise.reject(new TypeError('ECONNREFUSED')));
    expect(await runStep(seed({ state: 'PICK' }))).toEqual({ wait: 'waking model' });
  });

  it('returns "waiting on another run" when every slot is processing', async () => {
    on(/\/slots$/, () => json([{ is_processing: true }]));
    const result = await runStep(seed({ state: 'PICK' }));
    expect(result).toEqual({ wait: 'waiting on another run' });
    expect(saved().claim).toBeNull();
    expect(saved().state).toBe('PICK');
  });

  it('skips the model check for steps that only run ffmpeg', async () => {
    on(/\/health$/, () => new Response('', { status: 503 }));
    await runStep(seed({ state: 'PREP' }));
    expect(called(/\/health$/)).toHaveLength(0);
    expect(saved().state).toBe('ANALYZE');
  });
});

describe('runStep: claims', () => {
  it('waits when another tab holds an unexpired claim', async () => {
    const claim = { token: 'other', until: Date.now() + 60_000 };
    const result = await runStep(seed({ state: 'PREP', claim }));
    expect(result).toEqual({ wait: 'step running in another tab' });
    expect(saved().state).toBe('PREP');
    expect(saved().claim).toEqual(claim);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('takes over a lapsed claim', async () => {
    await runStep(seed({ state: 'PREP', claim: { token: 'old', until: Date.now() - 1 } }));
    expect(saved().state).toBe('ANALYZE');
    expect(saved().claim).toBeNull();
  });
});

describe('runStep: PREP', () => {
  it('probes and measures the whole file through a signed URL, then starts ANALYZE', async () => {
    expect(await runStep(seed({ state: 'PREP', consecutiveFailures: 1, error: 'x' }))).toEqual({});
    const job = saved();
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
    expect(job.claim).toBeNull();
    const signed = 'https://storage.googleapis.com/bkt/uploads/j1?sig=read';
    for (const [, args] of h.spawn.mock.calls as [string, string[]][]) {
      expect(args).toContain(signed);
    }
    expect(h.spawn.mock.calls.map(([cmd]) => cmd)).toEqual(['ffprobe', 'ffmpeg']);
  });

  it('fails when the upload never reached storage', async () => {
    h.objects.clear();
    await runStep(seed({ state: 'PREP' }));
    expect(saved()).toMatchObject({ state: 'FAILED', failedState: 'PREP' });
    expect(saved().error).toMatch(/never reached storage/);
  });

  it.each([Number.NaN, 0])('fails a video whose duration reads as %s', async (duration) => {
    tools.probe = { stdout: probeJson(duration) };
    await runStep(seed({ state: 'PREP' }));
    expect(saved()).toMatchObject({ state: 'FAILED', failedState: 'PREP' });
    expect(saved().error).toMatch(/duration/);
  });

  it('fails a video with no audio track', async () => {
    tools.probe = { stdout: probeJson(60, false) };
    await runStep(seed({ state: 'PREP' }));
    expect(saved()).toMatchObject({
      state: 'FAILED',
      failedState: 'PREP',
      error: 'This video has no audio track.',
    });
  });

  it(`caps visitor videos at ${MAX_MINUTES.visitor} minutes`, async () => {
    tools.probe = { stdout: probeJson(5 * 60 + 1) };
    await runStep(seed({ state: 'PREP' }));
    expect(saved()).toMatchObject({ state: 'FAILED', failedState: 'PREP' });
    expect(saved().error).toBe('Videos are capped at 5 minutes here; this one runs 5.0.');
  });

  it('accepts exactly 5 minutes from a visitor', async () => {
    tools.probe = { stdout: probeJson(300) };
    await runStep(seed({ state: 'PREP' }));
    expect(saved().state).toBe('ANALYZE');
  });

  it(`lets Nathan run up to ${MAX_MINUTES.nathan} minutes`, async () => {
    tools.probe = { stdout: probeJson(12 * 60) };
    await runStep(seed({ state: 'PREP', owner: 'nathan', channel: 'nathan' }));
    expect(saved().state).toBe('ANALYZE');
    expect(saved().chunkCount).toBe(Math.ceil((720 - 1) / 29.5));
  });

  it('refuses Nathan past 15 minutes', async () => {
    tools.probe = { stdout: probeJson(16 * 60) };
    await runStep(seed({ state: 'PREP', owner: 'nathan', channel: 'nathan' }));
    expect(saved().state).toBe('FAILED');
    expect(saved().error).toBe('Videos are capped at 15 minutes here; this one runs 16.0.');
  });

  it('counts an ffprobe crash as a failure without leaving PREP', async () => {
    tools.probe = { code: 1, stderr: 'Invalid data found' };
    await runStep(seed({ state: 'PREP' }));
    expect(saved()).toMatchObject({ state: 'PREP', consecutiveFailures: 1 });
    expect(saved().error).toMatch(/ffprobe exited 1/);
  });
});

describe('runStep: ANALYZE', () => {
  it('stores no chunk when the job was discarded mid-analysis', async () => {
    const job = seed({ state: 'ANALYZE', probe: PROBE, chunkCount: 2, chunkIndex: 0 });
    on(/v1\/chat\/completions$/, () => {
      store.set('jobs/j1', { ...(store.get('jobs/j1') as JobDoc), state: 'DISCARDED' });
      return completion(JSON.stringify(ANALYSIS));
    });
    await runStep(job);
    expect(saved().state).toBe('DISCARDED');
    expect(store.has('jobs/j1/chunks/0000')).toBe(false);
  });

  it('saves the chunk and advances to the next window', async () => {
    const result = await runStep(
      seed({ state: 'ANALYZE', probe: PROBE, chunkCount: 2, chunkIndex: 0 }),
    );
    expect(result).toEqual({});
    expect(saved()).toMatchObject({ state: 'ANALYZE', chunkIndex: 1, consecutiveFailures: 0 });
    const chunk = store.get('jobs/j1/chunks/0000') as { index: number; analysis: unknown };
    expect(chunk).toMatchObject({ index: 0, startSec: 0, durationSec: 29.5, raw: null });
    expect(chunk.analysis).toEqual(ANALYSIS);
    const body = chatBodies()[0]!;
    expect(body.temperature).toBeCloseTo(0.2);
    expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
  });

  it('moves to PICK after the last chunk, cutting the short tail window', async () => {
    await runStep(seed({ state: 'ANALYZE', probe: PROBE, chunkCount: 2, chunkIndex: 1 }));
    expect(saved()).toMatchObject({ state: 'PICK', chunkIndex: 2 });
    expect(store.get('jobs/j1/chunks/0001')).toMatchObject({
      index: 1,
      startSec: 29.5,
      durationSec: 10.5,
    });
    const args = h.spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('-ss') + 1]).toBe('29.500');
    expect(args[args.indexOf('-t') + 1]).toBe('10.500');
  });

  it('counts one thrown step, keeps the state, and fails on the second in a row', async () => {
    store.set('jobs/j1/chunks/0000', { index: 0 });
    tools.window = { code: 1, stderr: 'boom\nmoov atom not found' };
    await runStep(seed({ state: 'ANALYZE', probe: PROBE, chunkCount: 3, chunkIndex: 1 }));
    expect(saved()).toMatchObject({ state: 'ANALYZE', chunkIndex: 1, consecutiveFailures: 1 });
    expect(saved().error).toMatch(/ffmpeg exited 1/);
    expect(saved().claim).toBeNull();

    await runStep(saved());
    expect(saved()).toMatchObject({
      state: 'FAILED',
      failedState: 'ANALYZE',
      consecutiveFailures: 2,
      chunkIndex: 1,
    });
    expect(store.has('jobs/j1/chunks/0000')).toBe(true);
  });

  it('resets the failure count after a step succeeds', async () => {
    await runStep(seed({ state: 'ANALYZE', probe: PROBE, chunkCount: 3, consecutiveFailures: 1 }));
    expect(saved()).toMatchObject({ consecutiveFailures: 0, error: null, chunkIndex: 1 });
  });

  it('keeps the raw reply when the model never returns valid JSON', async () => {
    on(/chat\/completions$/, () => completion('not json'));
    await runStep(seed({ state: 'ANALYZE', probe: PROBE, chunkCount: 2 }));
    expect(store.get('jobs/j1/chunks/0000')).toMatchObject({ analysis: null, raw: 'not json' });
    expect(saved().chunkIndex).toBe(1);
  });
});

describe('runStep: PICK', () => {
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

  beforeEach(() => {
    store.set('jobs/j1/chunks/0000', chunkDoc(0));
    store.set('jobs/j1/chunks/0001', chunkDoc(1));
  });

  it('stores candidates and pick version 1 for a visitor job, named as the artist with public facts only', async () => {
    expect(await runStep(seed({ state: 'PICK', measurements: MEASURED }))).toEqual({});
    const job = saved();
    expect(job.state).toBe('REVIEW');
    expect(job.hashtagCandidates).toEqual(['#synthwave', '#retrowave', '#newmusic']);
    const pick = store.get('jobs/j1/pick/0001') as Record<string, unknown>;
    expect(pick).toMatchObject({ version: 1, skipped: false });
    expect(typeof pick.modelMs).toBe('number');
    for (const tag of pick.hashtags as string[]) expect(job.hashtagCandidates).toContain(tag);

    const ctx = context();
    expect(ctx.artist).toBe('Flies Like Robots');
    expect(ctx.facts.map((f) => f.key)).toEqual(['artist-name']);
    expect(ctx.feedback).toEqual([]);
    expect(ctx.skippedVersions).toBeUndefined();
    expect([...store.keys()].some((k) => k.startsWith('artists/'))).toBe(false);
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(1);
    // Visitor runs read like Nathan too, so his uploads supply the credits.
    expect(called(/playlistItems/).length).toBeGreaterThan(0);
    expect(ctx.recentUploads).toHaveLength(3);
    expect(job.audience).toMatchObject({ hashtags: job.hashtagCandidates });
  });

  it('names the artist for a sample and leaves its live video out of the comparison set', async () => {
    await runStep(seed({ state: 'PICK', sampleId: 'smp', liveVideoId: 'v2', channel: 'sandbox' }));
    expect(context().artist).toBe('Flies Like Robots');
    const catalog = called(/com\/youtube\/v3\/videos\?/).map((c) =>
      new URL(c.url).searchParams.get('id'),
    );
    expect(catalog[0]).toBe('v1,v3,v4,v5,v6');
    // Only the three newest uploads go to the model, each with its thumbnail.
    expect(context().recentUploads).toHaveLength(3);
    expect(called(/i\.ytimg\.com/)).toHaveLength(3);
  });

  it("reads Nathan's memory for a demo job without writing any of it", async () => {
    store.set('artists/flr/feedback/f1', {
      kind: 'EDITED',
      jobId: 'old',
      songTitle: 'Earlier',
      pickVersion: 1,
      field: 'title',
      before: 'A',
      after: 'B',
      at: 5,
    });
    const before = [...store.keys()].filter((k) => k.startsWith('artists/')).sort();
    await runStep(seed({ state: 'PICK', owner: 'demo', channel: 'sandbox' }));
    expect(saved().state).toBe('REVIEW');
    const ctx = context();
    expect(ctx.feedback).toHaveLength(1);
    expect(ctx.facts.map((f) => f.key)).toEqual(['artist-name', 'home']);
    const after = [...store.keys()].filter((k) => k.startsWith('artists/')).sort();
    expect(after).toEqual(before);
    expect(store.has('artists/flr/facts/home')).toBe(false);
  });

  it("uses Nathan's facts, feedback, cached candidates, and skipped versions", async () => {
    store.set('artists/flr/feedback/f1', {
      kind: 'EDITED',
      jobId: 'old',
      songTitle: 'Earlier',
      pickVersion: 1,
      field: 'title',
      before: 'A',
      after: 'B',
      at: 5,
    });
    store.set('jobs/j1/pick/0001', {
      ...RAW_PICK,
      title: 'Old Title',
      description: 'An older description.',
      version: 1,
      skipped: true,
    });
    store.set('jobs/j1/pick/0002', {
      ...RAW_PICK,
      title: 'Second',
      version: 2,
      skipped: false,
      modelMs: 50_000,
    });
    await runStep(
      seed({
        state: 'PICK',
        owner: 'nathan',
        channel: 'nathan',
        hashtagCandidates: ['#synthwave', '#retrowave', '#newmusic'],
        audience: {
          query: 'synthwave music video',
          hashtags: ['#synthwave', '#retrowave', '#newmusic'],
          tags: [
            { tag: 'synthwave', usedBy: 9 },
            { tag: 'outrun', usedBy: 4 },
          ],
          top: [{ title: 'Top', description: 'd', tags: ['outrun'], views: 9 }],
        },
      }),
    );
    expect(saved().state).toBe('REVIEW');
    const third = store.get('jobs/j1/pick/0003') as { version: number; modelMs: number };
    expect(third.version).toBe(3);
    // The stored time carries the earlier runs, so a re-run never drops them from the total.
    expect(third.modelMs).toBeGreaterThanOrEqual(50_000);
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(0);
    const ctx = context();
    expect(ctx.artist).toBe('Flies Like Robots');
    expect(ctx.candidateTags).toEqual([
      { tag: 'synthwave', usedBy: 9 },
      { tag: 'outrun', usedBy: 4 },
      { tag: 'Flies Like Robots', usedBy: 0 },
    ]);
    expect(ctx.audienceTopVideos).toEqual([
      { title: 'Top', description: 'd', tags: ['outrun'], views: 9 },
    ]);
    // The private INFERENCE is read but never reaches the prompt.
    expect(ctx.facts.map((f) => f.key)).toEqual(['artist-name', 'home']);
    expect(ctx.feedback).toHaveLength(1);
    expect(ctx.skippedVersions).toEqual([
      { title: 'Old Title', description: 'An older description.' },
    ]);
    expect(store.has('artists/flr/facts/home')).toBe(true);
  });

  const GUIDE = { statement: 'Plain titles.', keep: ['Song only'], fix: [], drop: ['Emoji'] };
  const approveGuide = () =>
    store.set('artists/flr/brand/approved', {
      ...GUIDE,
      status: 'APPROVED',
      basedOn: ['v1'],
      createdAt: 1,
      approvedAt: 2,
    });

  it("follows Nathan's approved brand guide", async () => {
    approveGuide();
    await runStep(seed({ state: 'PICK', owner: 'nathan', channel: 'nathan' }));
    expect(context().brandGuide).toEqual(GUIDE);
  });

  it('keeps the brand guide out of visitor jobs', async () => {
    approveGuide();
    await runStep(seed({ state: 'PICK', sampleId: 'smp', channel: 'sandbox' }));
    expect(context()).not.toHaveProperty('brandGuide');
  });

  it('counts an unparseable recommendation as a failure', async () => {
    on(/chat\/completions$/, () => completion('{"title": 1}'));
    await runStep(seed({ state: 'PICK' }));
    expect(saved()).toMatchObject({ state: 'PICK', consecutiveFailures: 1 });
    expect(saved().error).toBe('The model reply did not parse as a recommendation.');
    expect(store.has('jobs/j1/pick/0001')).toBe(false);
  });

  it('reports the original model error to Sentry, not the evidence-carrying wrapper', async () => {
    captureException.mockClear();
    on(/chat\/completions$/, () => completion('{"title": 1}'));
    await runStep(seed({ state: 'PICK' }));
    expect(captureException).toHaveBeenCalledTimes(1);
    const [reported, context] = captureException.mock.calls[0]!;
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).constructor.name).toBe('Error');
    expect((reported as Error).message).toBe('The model reply did not parse as a recommendation.');
    expect(context).toEqual({ tags: { step: 'PICK' } });
  });

  it('keeps the genre search when the model fails, so the retry does not search again', async () => {
    on(/chat\/completions$/, () => completion('{"title": 1}'));
    await runStep(seed({ state: 'PICK' }));
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(1);
    expect(saved().audience).toMatchObject({ hashtags: ['#synthwave', '#retrowave', '#newmusic'] });

    on(/chat\/completions$/, () => completion(JSON.stringify(RAW_PICK)));
    await runStep(saved());
    expect(saved()).toMatchObject({ state: 'REVIEW', consecutiveFailures: 0 });
    expect(called(/youtube\/v3\/search\?/)).toHaveLength(1);
  });
});

describe('runStep: PUBLISHING', () => {
  const publishing = (patch: Partial<JobDoc> = {}) =>
    seed({ state: 'PUBLISHING', channel: 'sandbox', finalFields: FIELDS, sampleId: 's', ...patch });

  beforeEach(() => {
    h.secrets.set('yt-refresh-sandbox', 'refresh-1');
  });

  it('fails when there is nothing to upload', async () => {
    await runStep(publishing({ finalFields: null }));
    expect(saved()).toMatchObject({ state: 'FAILED', failedState: 'PUBLISHING' });
  });

  it('ends at the payload when the channel has no token', async () => {
    h.secrets.clear();
    await runStep(publishing());
    expect(saved()).toMatchObject({ state: 'PAYLOAD', payload: FIELDS });
  });

  it('tells the page why it stopped at the payload', async () => {
    h.secrets.clear();
    await runStep(publishing());
    expect(saved().error).toBe('The upload channel is not connected.');
  });

  it('opens a private resumable upload sized from storage', async () => {
    await runStep(publishing());
    expect(saved()).toMatchObject({
      state: 'PUBLISHING',
      upload: { sessionUri: 'https://upload.example/s1', total: 1000 },
      uploadProgress: { sent: 0, total: 1000 },
    });
    const init = called(/upload\/youtube\/v3\/videos/)[0]!.init;
    expect(headers(init)['x-upload-content-length']).toBe('1000');
    expect(headers(init).authorization).toBe('Bearer access-1');
    expect(JSON.parse(String(init.body)).status).toEqual({
      privacyStatus: 'private',
      selfDeclaredMadeForKids: false,
    });
  });

  it('fails when the source expired from storage', async () => {
    h.objects.clear();
    await runStep(publishing());
    expect(saved()).toMatchObject({ state: 'FAILED', failedState: 'PUBLISHING' });
  });

  it('ends at the payload when upload quota is spent', async () => {
    on(
      /upload\/youtube\/v3\/videos/,
      () => new Response('{"error":{"errors":[{"reason":"quotaExceeded"}]}}', { status: 403 }),
    );
    await runStep(publishing());
    expect(saved()).toMatchObject({
      state: 'PAYLOAD',
      payload: FIELDS,
      error: 'YouTube upload quota is spent for today.',
    });
  });

  it('counts other upload-init errors as step failures', async () => {
    on(/upload\/youtube\/v3\/videos/, () => new Response('forbidden', { status: 403 }));
    await runStep(publishing());
    expect(saved()).toMatchObject({ state: 'PUBLISHING', consecutiveFailures: 1, upload: null });
  });

  it('streams the next range from GCS and records progress on a 308', async () => {
    on(/upload\.example\/s1/, (_url, init) =>
      headers(init)['content-range'] === 'bytes */1000'
        ? new Response('', { status: 308, headers: { range: 'bytes=0-399' } })
        : new Response('', { status: 308, headers: { range: 'bytes=0-699' } }),
    );
    await runStep(publishing({ upload: { sessionUri: 'https://upload.example/s1', total: 1000 } }));
    expect(saved()).toMatchObject({
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
    await runStep(publishing({ upload: { sessionUri: 'https://upload.example/s1', total: 1000 } }));
    expect(saved()).toMatchObject({
      state: 'CLAIMED_COMPLETE',
      videoId: 'vid1',
      uploadProgress: { sent: 1000, total: 1000 },
    });
  });

  it('drops an expired upload session so the next step opens a fresh one', async () => {
    on(/upload\.example\/s1/, () => new Response('gone', { status: 404 }));
    await runStep(publishing({ upload: { sessionUri: 'https://upload.example/s1', total: 1000 } }));
    expect(saved()).toMatchObject({ state: 'PUBLISHING', upload: null, uploadProgress: null });
  });

  it('skips the range read when YouTube already holds every byte', async () => {
    on(/upload\.example\/s1/, () => json({ id: 'vid2' }));
    await runStep(publishing({ upload: { sessionUri: 'https://upload.example/s1', total: 1000 } }));
    expect(saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', videoId: 'vid2' });
    expect(called(/storage\.googleapis\.com/)).toHaveLength(0);
  });
});

describe('runStep: CLAIMED_COMPLETE', () => {
  const claimed = (patch: Partial<JobDoc> = {}) =>
    seed({
      state: 'CLAIMED_COMPLETE',
      owner: 'nathan',
      channel: 'nathan',
      videoId: 'vid1',
      finalFields: FIELDS,
      ...patch,
    });

  beforeEach(() => {
    h.secrets.set('yt-refresh-nathan', 'refresh-n');
    h.secrets.set('yt-refresh-sandbox', 'refresh-s');
  });

  it('marks VERIFIED on read-back and records the publish for Nathan', async () => {
    expect(await runStep(claimed())).toEqual({});
    expect(saved().state).toBe('VERIFIED');
    expect(store.get('artists/flr/publishes/vid1')).toMatchObject({
      videoId: 'vid1',
      url: 'https://youtu.be/vid1',
      jobId: 'j1',
      fields: FIELDS,
      status: 'VERIFIED',
    });
    expect(headers(called(/com\/youtube\/v3\/videos\?/)[0]!.init).authorization).toBe(
      'Bearer access-1',
    );
  });

  it('verifies a visitor sample without touching artists/*', async () => {
    await runStep(claimed({ owner: 'visitor', channel: 'sandbox' }));
    expect(saved().state).toBe('VERIFIED');
    expect([...store.keys()].some((k) => k.startsWith('artists/'))).toBe(false);
  });

  it('fails when YouTube rejected the upload', async () => {
    on(/com\/youtube\/v3\/videos\?/, () =>
      json({ items: [{ id: 'vid1', status: { uploadStatus: 'rejected' } }] }),
    );
    await runStep(claimed());
    expect(saved()).toMatchObject({ state: 'FAILED', error: 'YouTube rejected the upload.' });
    expect(store.has('artists/flr/publishes/vid1')).toBe(false);
  });

  it('keeps waiting while a listed upload has no accepted status yet', async () => {
    on(/com\/youtube\/v3\/videos\?/, () => json({ items: [{ id: 'vid1', status: {} }] }));
    expect(await runStep(claimed())).toEqual({ wait: 'waiting on YouTube' });
    expect(saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', verifyAttempts: 1 });
  });

  it('waits on YouTube while the video is not listed yet', async () => {
    on(/com\/youtube\/v3\/videos\?/, () => json({ items: [] }));
    expect(await runStep(claimed({ verifyAttempts: 2 }))).toEqual({ wait: 'waiting on YouTube' });
    expect(saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', verifyAttempts: 3 });
  });

  it(`fails after ${VERIFY_ATTEMPTS} empty read-backs`, async () => {
    on(/com\/youtube\/v3\/videos\?/, () => json({ items: [] }));
    expect(await runStep(claimed({ verifyAttempts: VERIFY_ATTEMPTS - 1 }))).toEqual({});
    expect(saved()).toMatchObject({ state: 'FAILED', failedState: 'CLAIMED_COMPLETE' });
    expect(saved().error).toBe('YouTube never returned the uploaded video.');
  });

  it('fails when there is no channel to read back from', async () => {
    await runStep(claimed({ channel: null }));
    expect(saved()).toMatchObject({ state: 'FAILED', failedState: 'CLAIMED_COMPLETE' });
  });

  it('fails when the channel lost its token', async () => {
    h.secrets.clear();
    await runStep(claimed());
    expect(saved()).toMatchObject({ state: 'FAILED', error: 'Cannot read the upload back.' });
  });

  it('counts a read-back error as a failure and asks the page to wait', async () => {
    on(/com\/youtube\/v3\/videos\?/, () => new Response('oops', { status: 500 }));
    expect(await runStep(claimed())).toEqual({ wait: 'waiting on YouTube' });
    expect(saved()).toMatchObject({ state: 'CLAIMED_COMPLETE', consecutiveFailures: 1 });
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
});

describe('runStep: claim safety', () => {
  it('runs the step on the job read inside the claim, not the caller snapshot', async () => {
    const stale = seed({ state: 'PICK' });
    store.set('jobs/j1', { ...stale, state: 'REVIEW' });
    expect(await runStep(stale)).toEqual({});
    expect(saved().state).toBe('REVIEW');
    expect(saved().claim).toBeNull();
    expect(chatBodies()).toHaveLength(0);
  });

  it('waits on a loading model when the claimed state is ahead of the snapshot', async () => {
    const stale = seed({ state: 'PREP' });
    store.set('jobs/j1', { ...stale, state: 'ANALYZE', chunkCount: 2 });
    on(/127\.0\.0\.1:8081\/health$/, () => new Response('loading', { status: 503 }));
    expect(await runStep(stale)).toEqual({ wait: 'waking model' });
    expect(saved()).toMatchObject({ state: 'ANALYZE', claim: null });
    expect(chatBodies()).toHaveLength(0);
  });

  it('drops the step result when the job was discarded mid-step', async () => {
    const job = seed({ state: 'PICK', owner: 'visitor', sampleId: 's1' });
    on(/v1\/chat\/completions$/, () => {
      store.set('jobs/j1', { ...(store.get('jobs/j1') as JobDoc), state: 'DISCARDED' });
      return completion(JSON.stringify(RAW_PICK));
    });
    await runStep(job);
    expect(saved().state).toBe('DISCARDED');
    expect(saved().claim).toBeNull();
    expect(store.has('jobs/j1/pick/0001')).toBe(false);
  });
});

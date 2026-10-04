// @vitest-environment node
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../helpers/fake-firestore';
import { agentSpanIO, clearAgentSpan } from '../../../helpers/agent-span';
import { span, startSpan } from '../../../mocks/sentry';
import { resetClients } from '$lib/server/clients';
import type { JobDoc } from '$lib/server/jobs';
import {
  buildHookMessages,
  hookStep,
  isRawHook,
  MIN_RISE_LU,
  placeCut,
  renderStep,
  runHook,
  settleHook,
  type HookContext,
} from '$lib/server/short';
import type { Chunk, Short } from '$lib/types';

const h = vi.hoisted(() => ({
  objects: new Set<string>(),
  spawn: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

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
          getMetadata: async () => [{ size: '4096', contentType: 'video/mp4' }],
        }),
      };
    }
  },
}));

vi.mock('node:child_process', () => ({ spawn: h.spawn }));

type Run = { stderr?: string; stdout?: string; code?: number; onRun?: (args: string[]) => void };
let runs: { loudness: Run; render: Run; probe: Run };

function child(run: Run) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdio: [null, stdout, stderr, new EventEmitter()],
  });
  setImmediate(() => {
    if (run.stdout) stdout.emit('data', Buffer.from(run.stdout));
    if (run.stderr) stderr.emit('data', Buffer.from(run.stderr));
    proc.emit('close', run.code ?? 0);
  });
  return proc;
}

const ebur = (points: [number, number][]) =>
  points
    .map(([t, m]) => `[Parsed_ebur128_0 @ 0x1] t: ${t}  TARGET:-23 LUFS    M: ${m} S: ${m}`)
    .join('\n');

/** Quiet until `at`, loud after, across `from`..`to` in file time, as ebur128 prints it from `from`. */
const step = (from: number, to: number, at: number) => {
  const points: [number, number][] = [];
  for (let t = 0.1; from + t <= to + 1e-9; t = Math.round((t + 0.1) * 10) / 10) {
    points.push([t, from + t <= at ? -40 : -12]);
  }
  return ebur(points);
};

const fetchMock = vi.fn<typeof fetch>();
const completion = (content: string) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 3 } }),
    { headers: { 'content-type': 'application/json' } },
  );
const chatBodies = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/v1/chat/completions'))
    .map(([, init]) => JSON.parse(String(init?.body)) as { messages: { content: unknown }[] });

const chunk = (index: number, lufs: number | null = -14): Chunk => ({
  index,
  startSec: index * 29.5,
  durationSec: 29.5,
  measurements: {
    integratedLufs: lufs,
    truePeakDbtp: -1,
    peakLevelDb: -1,
    clippedSamples: 0,
    silences: [],
  },
  analysis: {
    visual: index === 2 ? 'Strobe-lit chorus with the full band' : 'Slow pan over a city',
    music: {
      genre: ['synthwave'],
      tempoFeel: 'driving',
      instrumentation: ['synth'],
      vocals: 'male',
      mood: [],
    },
    qualityFlags: [],
  },
  raw: null,
  modelMs: 1,
});

const ctx = (patch: Partial<HookContext> = {}): HookContext => ({
  songTitle: 'PeekaBoo',
  notes: '',
  sourceDurationSec: 180,
  chunks: [0, 1, 2, 3, 4, 5].map((i) => chunk(i)),
  skipped: [],
  ...patch,
});

const SHORT: Short = {
  parentId: 'p1',
  sourceDurationSec: 180,
  reframe: 'blur',
  hook: null,
  skipped: [],
  renders: 0,
  modelMs: 0,
};

function shortJob(patch: Partial<JobDoc> = {}, short: Partial<Short> = {}): JobDoc {
  return {
    id: 's1',
    state: 'HOOK',
    owner: 'visitor',
    channel: 'sandbox',
    songTitle: 'PeekaBoo',
    notes: 'first single',
    filename: 'peekaboo (Short).mp4',
    contentType: 'video/mp4',
    sampleId: null,
    liveVideoId: null,
    object: 'uploads/s1',
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
    consecutiveFailures: 1,
    claim: null,
    trace: null,
    hashtagCandidates: ['#synthwave'],
    audience: null,
    upload: null,
    finalFields: null,
    pickVersion: 1,
    verifyAttempts: 0,
    shortId: null,
    short: { ...SHORT, ...short },
    sourceObject: 'uploads/p1',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

const seedChunks = (count: number) => {
  for (let i = 0; i < count; i++) {
    store.set(`jobs/p1/chunks/${String(i).padStart(4, '0')}`, chunk(i));
  }
};

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  resetStore();
  resetClients();
  h.objects.clear();
  h.upload.mockReset();
  h.upload.mockImplementation(async (_path: string, { destination }: { destination: string }) => {
    h.objects.add(destination);
  });
  startSpan.mockClear();
  clearAgentSpan();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  runs = {
    loudness: { stderr: step(56, 90.5, 70) },
    render: {},
    probe: {
      stdout: JSON.stringify({
        format: { duration: '30.07' },
        streams: [{ codec_type: 'video', width: 1080, height: 1920 }, { codec_type: 'audio' }],
      }),
    },
  };
  h.spawn.mockReset();
  h.spawn.mockImplementation((command: string, args: string[]) => {
    const run =
      command === 'ffprobe' ? runs.probe : args.includes('-movflags') ? runs.render : runs.loudness;
    run.onRun?.(args);
    return child(run);
  });
});

describe('isRawHook', () => {
  it('accepts a window, a length, and a reason', () => {
    expect(isRawHook({ window: 2, lengthSec: 30, reason: 'The chorus lands.' })).toBe(true);
  });

  it('rejects missing or mistyped fields', () => {
    expect(isRawHook({ window: '2', lengthSec: 30, reason: 'x' })).toBe(false);
    expect(isRawHook({ window: 2, lengthSec: Number.NaN, reason: 'x' })).toBe(false);
    expect(isRawHook({ window: 2, lengthSec: 30 })).toBe(false);
    expect(isRawHook(null)).toBe(false);
    expect(isRawHook('hook')).toBe(false);
  });
});

describe('settleHook', () => {
  it('keeps a valid pick as is', () => {
    expect(settleHook({ window: 2, lengthSec: 30, reason: 'Chorus.' }, ctx())).toEqual({
      window: 2,
      lengthSec: 30,
      reason: 'Chorus.',
    });
  });

  it('rounds and clamps the window to the analyzed windows', () => {
    expect(settleHook({ window: 9, lengthSec: 30, reason: '' }, ctx()).window).toBe(5);
    expect(settleHook({ window: -3, lengthSec: 30, reason: '' }, ctx()).window).toBe(0);
    expect(settleHook({ window: 1.6, lengthSec: 30, reason: '' }, ctx()).window).toBe(2);
  });

  it('clamps the length to 15–60 s, and to the source for a short sample', () => {
    expect(settleHook({ window: 0, lengthSec: 5, reason: '' }, ctx()).lengthSec).toBe(15);
    expect(settleHook({ window: 0, lengthSec: 600, reason: '' }, ctx()).lengthSec).toBe(60);
    const sample = ctx({ sourceDurationSec: 30, chunks: [chunk(0)] });
    expect(settleHook({ window: 0, lengthSec: 45, reason: '' }, sample).lengthSec).toBe(30);
  });

  it('strips model-emitted loudness numbers from the reason', () => {
    const { reason } = settleHook(
      { window: 2, lengthSec: 30, reason: 'The drop hits at -6 LUFS and 128 BPM.' },
      ctx(),
    );
    expect(reason).not.toMatch(/LUFS|BPM|-6|128/);
    expect(reason).toContain('The drop hits');
  });
});

describe('buildHookMessages', () => {
  it('sends text only: rules plus each window with its ffmpeg loudness', () => {
    const [system, user] = buildHookMessages(ctx({ notes: 'first single' }));
    expect(system!.role).toBe('system');
    expect(system!.content).toContain('15 to 60 seconds');
    expect(system!.content).not.toContain('skippedHooks');
    expect(typeof user!.content).toBe('string');
    const context = JSON.parse(user!.content as string) as {
      artistNotes: string;
      durationSec: number;
      windows: { window: number; at: number; integratedLufs?: number; visual: string }[];
      skippedHooks?: unknown;
    };
    expect(context.artistNotes).toBe('first single');
    expect(context.durationSec).toBe(180);
    expect(context.windows.map((w) => w.window)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(context.windows[2]).toMatchObject({ at: 59, integratedLufs: -14 });
    expect(context.windows[2]!.visual).toContain('chorus');
    expect(context.skippedHooks).toBeUndefined();
  });

  it('names the sample-length bounds and the skipped hooks on a re-pick', () => {
    const [system, user] = buildHookMessages(
      ctx({
        sourceDurationSec: 30,
        chunks: [chunk(0, null)],
        skipped: [{ window: 0, lengthSec: 20 }],
      }),
    );
    expect(system!.content).toContain('15 to 30 seconds');
    expect(system!.content).toContain('skippedHooks were rejected');
    const context = JSON.parse(user!.content as string) as {
      windows: { integratedLufs?: number }[];
      skippedHooks: unknown;
      artistNotes?: string;
    };
    expect(context.skippedHooks).toEqual([{ window: 0, lengthSec: 20 }]);
    expect(context.windows[0]).not.toHaveProperty('integratedLufs');
    expect(context).not.toHaveProperty('artistNotes');
  });
});

describe('runHook', () => {
  it('returns the settled pick and the model time', async () => {
    fetchMock.mockResolvedValueOnce(
      completion(JSON.stringify({ window: 2, lengthSec: 30, reason: 'Chorus.' })),
    );
    const result = await runHook(ctx());
    expect(result?.hook).toEqual({ window: 2, lengthSec: 30, reason: 'Chorus.' });
    const [body] = chatBodies();
    expect(body).toMatchObject({
      temperature: 0.2,
      max_tokens: 2048,
      response_format: { type: 'json_schema', json_schema: { name: 'hook_pick', strict: true } },
    });
  });

  it('asks again once when the pick repeats a skipped hook', async () => {
    fetchMock
      .mockResolvedValueOnce(completion(JSON.stringify({ window: 2, lengthSec: 30, reason: 'a' })))
      .mockResolvedValueOnce(completion(JSON.stringify({ window: 4, lengthSec: 20, reason: 'b' })));
    const result = await runHook(ctx({ skipped: [{ window: 2, lengthSec: 30 }] }));
    expect(result?.hook.window).toBe(4);
    const second = chatBodies()[1]!;
    expect(second.messages.at(-1)!.content).toBe(
      'That repeats a skipped hook. Pick a different one.',
    );
  });

  it('gives up when the retry repeats a skipped hook too', async () => {
    fetchMock.mockImplementation(async () =>
      completion(JSON.stringify({ window: 2, lengthSec: 30, reason: 'a' })),
    );
    expect(await runHook(ctx({ skipped: [{ window: 2, lengthSec: 30 }] }))).toBeNull();
    expect(chatBodies()).toHaveLength(2);
  });

  it('counts a clamped repeat as a repeat', async () => {
    fetchMock.mockImplementation(async () =>
      completion(JSON.stringify({ window: 7, lengthSec: 90, reason: 'a' })),
    );
    expect(await runHook(ctx({ skipped: [{ window: 5, lengthSec: 60 }] }))).toBeNull();
  });

  it('returns null when the reply never parses', async () => {
    fetchMock.mockImplementation(async () => completion('not json'));
    expect(await runHook(ctx())).toBeNull();
  });

  it('records the text-only request and the settled hook on the agent span', async () => {
    fetchMock.mockResolvedValueOnce(
      completion(JSON.stringify({ window: 9, lengthSec: 90, reason: 'Drop at -6 LUFS.' })),
    );
    const result = await runHook(ctx(), undefined, span as never);
    const { input, output } = agentSpanIO();
    expect(input).toHaveLength(1);
    expect(input[0]!['gen_ai.input.messages']).toContain('PeekaBoo');
    expect(input[0]!['gen_ai.system_instructions']).toContain('Pick the hook');
    expect(output).toEqual([JSON.stringify(result!.hook)]);
    expect(output[0]).not.toContain('LUFS');
  });

  it('records the first request only, not the repeat nudge', async () => {
    fetchMock
      .mockResolvedValueOnce(completion(JSON.stringify({ window: 2, lengthSec: 30, reason: 'a' })))
      .mockResolvedValueOnce(completion(JSON.stringify({ window: 4, lengthSec: 20, reason: 'b' })));
    await runHook(ctx({ skipped: [{ window: 2, lengthSec: 30 }] }), undefined, span as never);
    const { input, output } = agentSpanIO();
    expect(input).toHaveLength(1);
    expect(input[0]!['gen_ai.input.messages']).not.toContain('repeats a skipped hook');
    expect(output).toEqual([JSON.stringify({ window: 4, lengthSec: 20, reason: 'b' })]);
  });

  it('records no answer when the reply never parses', async () => {
    fetchMock.mockImplementation(async () => completion('not json'));
    await runHook(ctx(), undefined, span as never);
    expect(agentSpanIO().input).toHaveLength(1);
    expect(agentSpanIO().output).toEqual([]);
  });

  it('records nothing without a span', async () => {
    fetchMock.mockResolvedValueOnce(
      completion(JSON.stringify({ window: 2, lengthSec: 30, reason: 'x' })),
    );
    await runHook(ctx());
    expect(agentSpanIO()).toEqual({ input: [], output: [] });
  });

  it('propagates a model server error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('overloaded', { status: 503 }));
    await expect(runHook(ctx())).rejects.toThrow('llama-server 503');
  });
});

describe('placeCut', () => {
  const pts = (from: number, to: number, at: number, quiet = -40, loud = -12) => {
    const out: { t: number; m: number }[] = [];
    for (let t = from; t <= to + 1e-9; t = Math.round((t + 0.1) * 10) / 10) {
      out.push({ t, m: t <= at ? quiet : loud });
    }
    return out;
  };
  const cut = { windowStart: 59, windowEnd: 88.5, lengthSec: 30, sourceSec: 180 };

  it('starts on the quiet moment just before the biggest jump in loudness', () => {
    expect(placeCut(pts(56, 90.5, 70), cut)).toBe(70);
  });

  it('backs up to the quietest moment in the second before the hit', () => {
    const curve = pts(56, 90.5, 70).map((p) => (p.t === 69.4 ? { ...p, m: -60 } : p));
    expect(placeCut(curve, cut)).toBe(69.4);
  });

  it("keeps the window's start when nothing rises by the minimum", () => {
    expect(placeCut(pts(56, 90.5, 70, -14, -14 + MIN_RISE_LU - 0.5), cut)).toBe(59);
  });

  it('ignores a jump outside the window', () => {
    expect(placeCut(pts(40, 90.5, 50), cut)).toBe(59);
  });

  it('floors digital silence so a fade from nothing does not beat a real hit', () => {
    const curve = pts(56, 90.5, 80).map((p) => (p.t < 62 ? { ...p, m: -120.7 } : p));
    curve.forEach((p) => {
      if (p.t >= 62 && p.t <= 80) p.m = -60;
    });
    // The -120 → -60 step floors to -70 → -60 (10 LU); the hit at 80 rises 48 LU.
    expect(placeCut(curve, cut)).toBe(80);
  });

  it("keeps the window's start without a curve", () => {
    expect(placeCut([], cut)).toBe(59);
  });

  it('pulls the start back so the full length fits before the end', () => {
    expect(placeCut(pts(156, 180, 170), { ...cut, windowStart: 147.5, windowEnd: 180 })).toBe(150);
  });

  it('starts at zero when the source is no longer than the Short', () => {
    expect(
      placeCut(pts(0, 30, 10), { windowStart: 0, windowEnd: 30, lengthSec: 30, sourceSec: 30 }),
    ).toBe(0);
  });
});

describe('hookStep', () => {
  it('asks the model for the hook, places the start from loudness, and moves to RENDER', async () => {
    seedChunks(6);
    h.objects.add('uploads/p1');
    fetchMock.mockResolvedValueOnce(
      completion(JSON.stringify({ window: 2, lengthSec: 30, reason: 'The chorus lands.' })),
    );
    const patch = await hookStep(shortJob());
    expect(patch).toMatchObject({
      state: 'RENDER',
      consecutiveFailures: 0,
      error: null,
      short: {
        parentId: 'p1',
        reframe: 'blur',
        renders: 0,
        skipped: [],
        hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'The chorus lands.' },
      },
    });
    expect(patch.short!.modelMs).toBeGreaterThanOrEqual(0);
    const args = h.spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('-ss') + 1]).toBe('56.000');
    expect(args[args.indexOf('-t') + 1]).toBe('34.500');
    expect(args[args.indexOf('-i') + 1]).toContain('/uploads/p1?sig=read');
    const agent = startSpan.mock.calls.find(
      ([o]) => (o as { name: string }).name === 'invoke_agent hook-pick',
    );
    expect(agent).toBeDefined();
    expect(agentSpanIO().output).toEqual([
      JSON.stringify({ window: 2, lengthSec: 30, reason: 'The chorus lands.' }),
    ]);
  });

  it('adds each re-pick to the model time already spent on the Short', async () => {
    seedChunks(6);
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return completion(JSON.stringify({ window: 2, lengthSec: 30, reason: 'x' }));
    });
    const patch = await hookStep(shortJob({}, { modelMs: 40_000 }));
    expect(calls).toBe(1);
    expect(patch.short!.modelMs).toBeGreaterThanOrEqual(40_005);
    expect(patch.short!.modelMs).toBeLessThan(41_000);
  });

  it('scans from zero and stops at the end for the first and only window', async () => {
    store.set('jobs/p1/chunks/0000', chunk(0));
    runs.loudness = { stderr: step(0, 30, 8) };
    fetchMock.mockResolvedValueOnce(
      completion(JSON.stringify({ window: 0, lengthSec: 20, reason: 'Riff.' })),
    );
    const patch = await hookStep(shortJob({}, { sourceDurationSec: 30 }));
    expect(patch.short!.hook).toEqual({ window: 0, startSec: 8, lengthSec: 20, reason: 'Riff.' });
    const args = h.spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('-ss') + 1]).toBe('0.000');
    expect(args[args.indexOf('-t') + 1]).toBe('30.000');
  });

  it("throws when the source video's analysis is gone", async () => {
    await expect(hookStep(shortJob())).rejects.toThrow("The source video's analysis is gone.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the model reply never parses', async () => {
    seedChunks(6);
    fetchMock.mockImplementation(async () => completion('{"window": "two"}'));
    await expect(hookStep(shortJob())).rejects.toThrow('The model reply did not parse as a hook.');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('propagates a failed loudness pass', async () => {
    seedChunks(6);
    runs.loudness = { stderr: 'Server returned 403 Forbidden', code: 1 };
    fetchMock.mockResolvedValueOnce(
      completion(JSON.stringify({ window: 2, lengthSec: 30, reason: 'x' })),
    );
    await expect(hookStep(shortJob())).rejects.toThrow('ffmpeg exited 1');
  });

  it('refuses a job that is not a Short, or has no source', async () => {
    await expect(hookStep(shortJob({ short: null }))).rejects.toThrow('Not a Short job.');
    seedChunks(6);
    fetchMock.mockResolvedValueOnce(
      completion(JSON.stringify({ window: 2, lengthSec: 30, reason: 'x' })),
    );
    await expect(hookStep(shortJob({ sourceObject: null }))).rejects.toThrow(
      'The Short has no source video.',
    );
  });
});

describe('renderStep', () => {
  const HOOK = { window: 2, startSec: 70, lengthSec: 30, reason: 'Chorus.' };
  /** The render writes a real temp file, so the test can see it is cleaned up. */
  const writesFile = (args: string[]) => writeFileSync(args.at(-1)!, 'mp4');

  it('renders to a temp file, uploads it to a fresh object, reads it back, and moves to REVIEW', async () => {
    runs.render.onRun = writesFile;
    const patch = await renderStep(shortJob({ state: 'RENDER' }, { hook: HOOK, reframe: 'crop' }));
    expect(patch).toMatchObject({
      state: 'REVIEW',
      object: 'uploads/s1-1',
      probe: { durationSec: 30.07, width: 1080, height: 1920, hasAudio: true },
      short: { renders: 1, hook: HOOK, reframe: 'crop' },
      consecutiveFailures: 0,
      error: null,
    });
    const args = h.spawn.mock.calls[0]![1] as string[];
    const local = args.at(-1)!;
    expect(local).toBe(join(tmpdir(), 'short-s1-1.mp4'));
    expect(args[args.indexOf('-i') + 1]).toContain('/uploads/p1?sig=read');
    expect(args[args.indexOf('-ss') + 1]).toBe('70.000');
    expect(args[args.indexOf('-t') + 1]).toBe('30.000');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('crop=1080:1920');
    expect(h.upload).toHaveBeenCalledWith(local, {
      destination: 'uploads/s1-1',
      contentType: 'video/mp4',
    });
    const probeArgs = h.spawn.mock.calls[1]![1] as string[];
    expect(probeArgs.at(-1)).toContain('/uploads/s1-1?sig=read');
    expect(existsSync(local)).toBe(false);
  });

  it('numbers each re-render, so the player never shows a cached earlier cut', async () => {
    const patch = await renderStep(shortJob({ state: 'RENDER' }, { hook: HOOK, renders: 1 }));
    expect(patch.object).toBe('uploads/s1-2');
    expect(patch.short!.renders).toBe(2);
  });

  it('fails and cleans up the temp file when the upload is refused', async () => {
    runs.render.onRun = writesFile;
    h.upload.mockRejectedValueOnce(new Error('403 Forbidden'));
    await expect(renderStep(shortJob({ state: 'RENDER' }, { hook: HOOK }))).rejects.toThrow(
      '403 Forbidden',
    );
    expect(existsSync(join(tmpdir(), 'short-s1-1.mp4'))).toBe(false);
  });

  it('fails when the render reads back without playable video', async () => {
    runs.probe = { stdout: JSON.stringify({ format: {}, streams: [] }) };
    await expect(renderStep(shortJob({ state: 'RENDER' }, { hook: HOOK }))).rejects.toThrow(
      'The rendered Short has no playable video.',
    );
  });

  it('propagates an ffmpeg failure without uploading, and cleans up a partial file', async () => {
    runs.render = { stderr: 'Conversion failed!', code: 1, onRun: writesFile };
    await expect(renderStep(shortJob({ state: 'RENDER' }, { hook: HOOK }))).rejects.toThrow(
      'ffmpeg exited 1: Conversion failed!',
    );
    expect(h.upload).not.toHaveBeenCalled();
    expect(existsSync(join(tmpdir(), 'short-s1-1.mp4'))).toBe(false);
  });

  it('refuses a Short without a hook', async () => {
    await expect(renderStep(shortJob({ state: 'RENDER' }))).rejects.toThrow(
      'The Short has no hook to cut.',
    );
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

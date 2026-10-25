// @vitest-environment node
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { seed, truncate } from '../../../../helpers/db';
import { A_JOB, jobDoc, NATHAN_VOICE_RULES, seedJob, USERS } from '../../../../helpers/pipeline';
import { agentSpanIO, clearAgentSpan } from '../../../../helpers/agent-span';
import { interaction, unavailable503 } from '../../../../helpers/gemini';
import { span, startSpan } from '../../../../mocks/sentry';
import { ModelBusy, stepDeadline } from '#lib/server/ai/model.js';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { jobs } from '#lib/server/core/schema.js';
import type { JobDoc } from '#lib/server/jobs/jobs.js';
import {
  buildHookRequest,
  HOOK_SCHEMA,
  hookStep,
  isRawHook,
  MIN_RISE_LU,
  placeCut,
  renderStep,
  runHook,
  settleHook,
  STALE_ANALYSIS,
  type HookContext,
} from '#lib/server/pipeline/short.js';
import type { Chunk, Short } from '#lib/types.js';

const NOTES = 'first single';
const CHORUS = 'The chorus lands.';
const RENDER_FILE = 'short-s1-1.mp4';

const h = vi.hoisted(() => ({
  objects: new Set<string>(),
  spawn: vi.fn(),
  upload: vi.fn(),
}));

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
const hookReply = (hook: unknown) => interaction(JSON.stringify(hook));
type Turn = { type: string; content: { type: string; text?: string }[] };
const sentBodies = () =>
  fetchMock.mock.calls.map(
    ([, init]) =>
      JSON.parse(String(init?.body)) as {
        model: string;
        input: Turn[];
        store: boolean;
        response_format: unknown;
        generation_config: { max_output_tokens: number; thinking_level: string };
      },
  );
const userText = (request: ReturnType<typeof buildHookRequest>) => {
  const [part] = request.turns[0]!.parts;
  return part!.type === 'text' ? part!.text : '';
};

const chunk = (index: number, lufs: number | null = -14): Chunk => ({
  index,
  startSec: index * 60,
  durationSec: 60,
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
  chunks: [0, 1, 2].map((i) => chunk(i)),
  skipped: [],
  voice: null,
  ...patch,
});

const SHORT: Short = {
  sourceDurationSec: 180,
  reframe: 'blur',
  hook: null,
  skipped: [],
  renders: 0,
  modelMs: 0,
};

function shortJob(patch: Partial<JobDoc> = {}, short: Partial<Short> = {}): JobDoc {
  return jobDoc({
    id: 's1',
    state: 'HOOK',
    parentId: 'p1',
    notes: NOTES,
    filename: 'peekaboo (Short).mp4',
    object: 'uploads/s1',
    consecutiveFailures: 1,
    hashtagCandidates: ['#synthwave'],
    pickVersion: 1,
    short: { ...SHORT, ...short },
    sourceObject: 'uploads/p1',
    ...patch,
  });
}

/** Gives the source video `count` analyzed windows; a count off its 60 s windows is stale. */
const seedChunks = (count: number) =>
  db()
    .update(jobs)
    .set({
      chunks: Array.from({ length: count }, (_, i) => chunk(i)),
      data: sql`${jobs.data} || jsonb_build_object('chunkCount', ${count}::int)`,
    })
    .where(eq(jobs.id, 'p1'));

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  resetClients();
  await truncate();
  await seed(USERS);
  await seedJob({ id: 'p1', state: 'REVIEW', chunkCount: 3 });
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
    const render = args.includes('-movflags') ? runs.render : runs.loudness;
    const run = command === 'ffprobe' ? runs.probe : render;
    run.onRun?.(args);
    return child(run);
  });
});

describe('isRawHook', () => {
  it('accepts a window, a length, and a reason', () => {
    expect(isRawHook({ window: 2, lengthSec: 30, reason: CHORUS })).toBe(true);
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
    expect(settleHook({ window: 1, lengthSec: 30, reason: 'Chorus.' }, ctx())).toEqual({
      window: 1,
      lengthSec: 30,
      reason: 'Chorus.',
    });
  });

  it('rounds and clamps the window to the analyzed windows', () => {
    expect(settleHook({ window: 9, lengthSec: 30, reason: '' }, ctx()).window).toBe(2);
    expect(settleHook({ window: -3, lengthSec: 30, reason: '' }, ctx()).window).toBe(0);
    expect(settleHook({ window: 0.6, lengthSec: 30, reason: '' }, ctx()).window).toBe(1);
  });

  it('clamps the length to 15–60 s, and to the source for a short video', () => {
    expect(settleHook({ window: 0, lengthSec: 5, reason: '' }, ctx()).lengthSec).toBe(15);
    expect(settleHook({ window: 0, lengthSec: 600, reason: '' }, ctx()).lengthSec).toBe(60);
    const thirtySec = ctx({ sourceDurationSec: 30, chunks: [chunk(0)] });
    expect(settleHook({ window: 0, lengthSec: 45, reason: '' }, thirtySec).lengthSec).toBe(30);
  });

  it("caps a late window's length at what's left of the source from its start", () => {
    // Window 2 starts at 120 s of 150: 30 s of room, so the cut can start inside it.
    const late = ctx({ sourceDurationSec: 150 });
    expect(settleHook({ window: 2, lengthSec: 60, reason: '' }, late).lengthSec).toBe(30);
    expect(settleHook({ window: 2, lengthSec: 20, reason: '' }, late).lengthSec).toBe(20);
  });

  it('keeps the 15 s minimum for a window in the last 15 s of the source', () => {
    const tail = ctx({ sourceDurationSec: 130 });
    expect(settleHook({ window: 2, lengthSec: 60, reason: '' }, tail).lengthSec).toBe(15);
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

describe('buildHookRequest', () => {
  it('sends text only: rules plus each window with its ffmpeg loudness', () => {
    const request = buildHookRequest(ctx({ notes: NOTES }));
    expect(request.system).toContain('15 to 60 seconds');
    expect(request.system).not.toContain('skippedHooks');
    expect(request.turns).toHaveLength(1);
    expect(request.turns[0]!.role).toBe('user');
    expect(request.turns[0]!.parts.map((p) => p.type)).toEqual(['text']);
    const context = JSON.parse(userText(request)) as {
      artistNotes: string;
      durationSec: number;
      windows: { window: number; at: number; integratedLufs?: number; visual: string }[];
      skippedHooks?: unknown;
    };
    expect(context.artistNotes).toBe(NOTES);
    expect(context.durationSec).toBe(180);
    expect(context.windows.map((w) => w.window)).toEqual([0, 1, 2]);
    expect(context.windows[2]).toMatchObject({ at: 120, integratedLufs: -14 });
    expect(context.windows[2]!.visual).toContain('chorus');
    expect(context.skippedHooks).toBeUndefined();
  });

  it('names the length bounds and the skipped hooks on a re-pick', () => {
    const request = buildHookRequest(
      ctx({
        sourceDurationSec: 30,
        chunks: [chunk(0, null)],
        skipped: [{ window: 0, lengthSec: 20 }],
      }),
    );
    expect(request.system).toContain('15 to 30 seconds');
    expect(request.system).toContain('skippedHooks were rejected');
    const context = JSON.parse(userText(request)) as {
      windows: { integratedLufs?: number }[];
      skippedHooks: unknown;
      artistNotes?: string;
    };
    expect(context.skippedHooks).toEqual([{ window: 0, lengthSec: 20 }]);
    expect(context.windows[0]).not.toHaveProperty('integratedLufs');
    expect(context).not.toHaveProperty('artistNotes');
  });
});

describe('buildHookRequest voice', () => {
  it('writes reason in the approved voice, under the hook rules', () => {
    const { system } = buildHookRequest(ctx({ voice: { rules: ['Short.', 'Dry.'] } }));
    expect(system).toMatch(
      /Write reason the way the artist writes their own:\n- Short\.\n- Dry\.\nThe rules above outrank the voice rules\.$/,
    );
  });

  it("keeps today's prompt without an approved voice", () => {
    expect(buildHookRequest(ctx()).system).not.toContain('Write reason');
  });
});

describe('runHook', () => {
  it('returns the settled pick and the model time from one hook-pick call', async () => {
    fetchMock.mockResolvedValueOnce(hookReply({ window: 2, lengthSec: 30, reason: 'Chorus.' }));
    const result = await runHook(ctx(), stepDeadline());
    expect(result?.hook).toEqual({ window: 2, lengthSec: 30, reason: 'Chorus.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/v1beta\/interactions$/);
    const [body] = sentBodies();
    expect(body!.store).toBe(false);
    expect(body!.generation_config).toMatchObject({
      max_output_tokens: 8192,
      thinking_level: 'low',
    });
    expect(JSON.stringify(body!.response_format)).toContain(JSON.stringify(HOOK_SCHEMA));
  });

  it('asks again once, after its own answer, when the pick repeats a skipped hook', async () => {
    const repeat = { window: 2, lengthSec: 30, reason: 'a' };
    fetchMock
      .mockResolvedValueOnce(hookReply(repeat))
      .mockResolvedValueOnce(hookReply({ window: 1, lengthSec: 20, reason: 'b' }));
    const result = await runHook(ctx({ skipped: [{ window: 2, lengthSec: 30 }] }), stepDeadline());
    expect(result?.hook?.window).toBe(1);
    const [assistant, user] = sentBodies()[1]!.input.slice(-2);
    expect(assistant).toMatchObject({
      type: 'model_output',
      content: [{ type: 'text', text: JSON.stringify(repeat) }],
    });
    expect(user).toEqual({
      type: 'user_input',
      content: [{ type: 'text', text: 'That repeats a skipped hook. Pick a different one.' }],
    });
  });

  it('gives up when the retry repeats a skipped hook too', async () => {
    fetchMock.mockImplementation(async () => hookReply({ window: 2, lengthSec: 30, reason: 'a' }));
    const result = await runHook(ctx({ skipped: [{ window: 2, lengthSec: 30 }] }), stepDeadline());
    expect(result).toEqual({ hook: null, ms: expect.any(Number) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('counts a clamped repeat as a repeat', async () => {
    fetchMock.mockImplementation(async () => hookReply({ window: 7, lengthSec: 90, reason: 'a' }));
    const skipped = [{ window: 2, lengthSec: 60 }];
    expect((await runHook(ctx({ skipped }), stepDeadline()))?.hook).toBeNull();
  });

  it('returns null when the reply never parses', async () => {
    fetchMock.mockImplementation(async () => interaction('not json'));
    expect(await runHook(ctx(), stepDeadline())).toBeNull();
  });

  it('starts no call once the deadline is too close', async () => {
    await expect(runHook(ctx(), Date.now() + 1_000)).rejects.toThrow('ran out of time');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records the text-only request and the settled hook on the agent span', async () => {
    fetchMock.mockResolvedValueOnce(
      hookReply({ window: 9, lengthSec: 90, reason: 'Drop at -6 LUFS.' }),
    );
    const result = await runHook(ctx(), stepDeadline(), span as never);
    const { input, output } = agentSpanIO();
    expect(input).toHaveLength(1);
    expect(input[0]!['gen_ai.input.messages']).toContain('PeekaBoo');
    expect(input[0]!['gen_ai.system_instructions']).toContain('Pick the hook');
    expect(output).toEqual([JSON.stringify(result!.hook)]);
    expect(output[0]).not.toContain('LUFS');
  });

  it('records the first request only, not the repeat nudge', async () => {
    fetchMock
      .mockResolvedValueOnce(hookReply({ window: 2, lengthSec: 30, reason: 'a' }))
      .mockResolvedValueOnce(hookReply({ window: 1, lengthSec: 20, reason: 'b' }));
    await runHook(ctx({ skipped: [{ window: 2, lengthSec: 30 }] }), stepDeadline(), span as never);
    const { input, output } = agentSpanIO();
    expect(input).toHaveLength(1);
    expect(input[0]!['gen_ai.input.messages']).not.toContain('repeats a skipped hook');
    expect(output).toEqual([JSON.stringify({ window: 1, lengthSec: 20, reason: 'b' })]);
  });

  it('records no answer when the reply never parses', async () => {
    fetchMock.mockImplementation(async () => interaction('not json'));
    await runHook(ctx(), stepDeadline(), span as never);
    expect(agentSpanIO().input).toHaveLength(1);
    expect(agentSpanIO().output).toEqual([]);
  });

  it('propagates a busy model', async () => {
    fetchMock.mockImplementation(async () => unavailable503());
    await expect(runHook(ctx(), stepDeadline())).rejects.toThrow(ModelBusy);
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
    const curve = pts(56, 90.5, 70).map((p) =>
      Math.abs(p.t - 69.4) < 1e-9 ? { ...p, m: -60 } : p,
    );
    expect(placeCut(curve, cut)).toBeCloseTo(69.4, 9);
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

  it('backs up into a -inf silence gap before the hit', () => {
    const curve = pts(56, 90.5, 70).map((p) =>
      p.t > 69.45 && p.t <= 69.75 ? { ...p, m: -Infinity } : p,
    );
    expect(placeCut(curve, cut)).toBeCloseTo(69.5, 9);
  });

  it('finds a hit that comes straight out of -inf silence', () => {
    expect(placeCut(pts(56, 90.5, 70, -Infinity), cut)).toBe(70);
  });

  it("keeps the window's start without a curve", () => {
    expect(placeCut([], cut)).toBe(59);
  });

  it('pulls the start back so the full length fits before the end', () => {
    expect(placeCut(pts(156, 180, 170), { ...cut, windowStart: 147.5, windowEnd: 180 })).toBe(150);
  });

  it('never ends the cut past a source whose length is not on the tenth', () => {
    const start = placeCut(pts(0, 30, 28), {
      windowStart: 0,
      windowEnd: 29.5,
      lengthSec: 15,
      sourceSec: 30.06,
    });
    expect(start).toBe(15);
    expect(start + 15).toBeLessThanOrEqual(30.06);
  });

  it('starts at zero when the source is no longer than the Short', () => {
    expect(
      placeCut(pts(0, 30, 10), { windowStart: 0, windowEnd: 30, lengthSec: 30, sourceSec: 30 }),
    ).toBe(0);
  });
});

describe('hookStep', () => {
  it('asks the model for the hook, places the start from loudness, and moves to RENDER', async () => {
    await seedChunks(3);
    h.objects.add('uploads/p1');
    runs.loudness = { stderr: step(57, 122, 70) };
    fetchMock.mockResolvedValueOnce(hookReply({ window: 1, lengthSec: 30, reason: CHORUS }));
    const patch = await hookStep(shortJob(), stepDeadline());
    expect(patch).toMatchObject({
      state: 'RENDER',
      consecutiveFailures: 0,
      error: null,
      short: {
        reframe: 'blur',
        renders: 0,
        skipped: [],
        hook: { window: 1, startSec: 70, lengthSec: 30, reason: CHORUS },
      },
    });
    expect(patch.short!.modelMs).toBeGreaterThanOrEqual(0);
    const args = h.spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('-ss') + 1]).toBe('57.000');
    expect(args[args.indexOf('-t') + 1]).toBe('65.000');
    expect(args[args.indexOf('-i') + 1]).toContain('/uploads/p1?sig=read');
    const agent = startSpan.mock.calls.find(
      ([o]) => (o as { name: string }).name === 'invoke_agent hook-pick',
    );
    expect(agent).toBeDefined();
    expect(agentSpanIO().output).toEqual([
      JSON.stringify({ window: 1, lengthSec: 30, reason: CHORUS }),
    ]);
  });

  it.each([
    ["Nathan's job, with his approved voice", A_JOB, true],
    ['a job with no artist', {}, false],
  ])('reads the voice for %s', async (_label, patch, voiced) => {
    await seedChunks(3);
    h.objects.add('uploads/p1');
    runs.loudness = { stderr: step(57, 122, 70) };
    fetchMock.mockResolvedValueOnce(hookReply({ window: 1, lengthSec: 30, reason: CHORUS }));
    await hookStep(shortJob(patch), stepDeadline());
    const body = JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)));
    expect(body.includes(NATHAN_VOICE_RULES[0]!)).toBe(voiced);
  });

  it('fails at HOOK for a video analyzed at another window length, before any model call', async () => {
    // Six 29.5 s windows of a 180 s video: their indices would place the hook at the wrong time.
    await seedChunks(6);
    const patch = await hookStep(shortJob(), stepDeadline());
    expect(patch).toMatchObject({ state: 'FAILED', failedState: 'HOOK', error: STALE_ANALYSIS });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('adds each re-pick to the model time already spent on the Short', async () => {
    await seedChunks(3);
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      // Timers can fire a millisecond early by Date.now, so sleep well past the asserted 5 ms.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return hookReply({ window: 2, lengthSec: 30, reason: 'x' });
    });
    const patch = await hookStep(shortJob({}, { modelMs: 40_000 }), stepDeadline());
    expect(calls).toBe(1);
    expect(patch.short!.modelMs).toBeGreaterThanOrEqual(40_005);
    expect(patch.short!.modelMs).toBeLessThan(41_000);
  });

  it('scans from zero and stops at the end for the first and only window', async () => {
    await seedChunks(1);
    runs.loudness = { stderr: step(0, 30, 8) };
    fetchMock.mockResolvedValueOnce(hookReply({ window: 0, lengthSec: 20, reason: 'Riff.' }));
    const patch = await hookStep(shortJob({}, { sourceDurationSec: 30 }), stepDeadline());
    expect(patch.short!.hook).toEqual({ window: 0, startSec: 8, lengthSec: 20, reason: 'Riff.' });
    const args = h.spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('-ss') + 1]).toBe('0.000');
    expect(args[args.indexOf('-t') + 1]).toBe('30.000');
  });

  it("throws when the source video's analysis is gone", async () => {
    await expect(hookStep(shortJob(), stepDeadline())).rejects.toThrow(
      "The source video's analysis is gone.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws for a Short with no parent video', async () => {
    await seedChunks(3);
    await expect(hookStep(shortJob({ parentId: null }), stepDeadline())).rejects.toThrow(
      "The source video's analysis is gone.",
    );
  });

  it('throws when the model reply never parses', async () => {
    await seedChunks(3);
    fetchMock.mockImplementation(async () => interaction('{"window": "two"}'));
    await expect(hookStep(shortJob(), stepDeadline())).rejects.toThrow(
      'The model reply did not parse as a hook.',
    );
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('fails at HOOK for good when the retry repeats a skipped hook too', async () => {
    await seedChunks(3);
    fetchMock.mockImplementation(async () => hookReply({ window: 2, lengthSec: 30, reason: 'x' }));
    const skipped = [{ window: 2, lengthSec: 30 }];
    const patch = await hookStep(shortJob({}, { skipped, modelMs: 40_000 }), stepDeadline());
    expect(patch).toMatchObject({
      state: 'FAILED',
      failedState: 'HOOK',
      error: 'The model kept picking a skipped hook.',
      short: { hook: null, skipped },
    });
    expect(patch.short!.modelMs).toBeGreaterThanOrEqual(40_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('starts a long cut from a late window inside that window', async () => {
    await seedChunks(3);
    runs.loudness = { stderr: step(117, 150, 135) };
    fetchMock.mockResolvedValueOnce(hookReply({ window: 2, lengthSec: 60, reason: 'Outro.' }));
    const { hook } = (await hookStep(shortJob({}, { sourceDurationSec: 150 }), stepDeadline()))
      .short!;
    expect(hook).toMatchObject({ window: 2, startSec: 120, lengthSec: 30 });
    expect(hook!.startSec + hook!.lengthSec).toBeLessThanOrEqual(150);
  });

  it('leaves the loudness pass its whole time limit: no model re-ask that would eat into it', async () => {
    await seedChunks(3);
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    onTestFinished(() => now.mockRestore());
    // The first reply lands 45 s in and doesn't parse. 110 s budget − 35 s reserve − 45 s leaves
    // 30 s, under the 35 s a hook call needs; a 15 s reserve would have left 50 s and re-asked.
    fetchMock.mockImplementation(async () => {
      clock += 45_000;
      return interaction('not json');
    });
    await expect(hookStep(shortJob(), stepDeadline())).rejects.toThrow(
      'The model reply did not parse as a hook.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed loudness pass', async () => {
    await seedChunks(3);
    runs.loudness = { stderr: 'Server returned 403 Forbidden', code: 1 };
    fetchMock.mockResolvedValueOnce(hookReply({ window: 2, lengthSec: 30, reason: 'x' }));
    await expect(hookStep(shortJob(), stepDeadline())).rejects.toThrow('ffmpeg exited 1');
  });

  it('refuses a job that is not a Short, or has no source', async () => {
    await expect(hookStep(shortJob({ short: null }), stepDeadline())).rejects.toThrow(
      'Not a Short job.',
    );
    await seedChunks(3);
    fetchMock.mockResolvedValueOnce(hookReply({ window: 2, lengthSec: 30, reason: 'x' }));
    await expect(hookStep(shortJob({ sourceObject: null }), stepDeadline())).rejects.toThrow(
      'The Short has no source video.',
    );
  });
});

describe('renderStep', () => {
  const HOOK = { window: 1, startSec: 70, lengthSec: 30, reason: 'Chorus.' };
  /** The render writes a real temp file, so the test can see it is cleaned up. */
  const writesFile = (args: string[]) => writeFileSync(args.at(-1)!, 'mp4');

  it("renders in what the step's deadline leaves after the upload and read-back", async () => {
    runs.render.onRun = writesFile;
    const clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(clock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    onTestFinished(() => {
      now.mockRestore();
      timeout.mockRestore();
    });
    // 60 s left in the step: 20 s for the upload and 10 s for the read-back leave 30 s to render.
    await renderStep(shortJob({ state: 'RENDER' }, { hook: HOOK }), clock + 60_000);
    expect(timeout.mock.calls).toEqual([[30_000], [10_000]]);
    expect(h.upload).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 20_000 }),
    );
  });

  it('renders to a temp file, uploads it to a fresh object, reads it back, and moves to REVIEW', async () => {
    runs.render.onRun = writesFile;
    const patch = await renderStep(
      shortJob({ state: 'RENDER' }, { hook: HOOK, reframe: 'crop' }),
      stepDeadline(),
    );
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
    expect(local).toBe(join(tmpdir(), RENDER_FILE));
    expect(args[args.indexOf('-i') + 1]).toContain('/uploads/p1?sig=read');
    expect(args[args.indexOf('-ss') + 1]).toBe('70.000');
    expect(args[args.indexOf('-t') + 1]).toBe('30.000');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('crop=1080:1920');
    expect(h.upload).toHaveBeenCalledWith(local, {
      destination: 'uploads/s1-1',
      contentType: 'video/mp4',
      resumable: false,
      timeout: 20_000,
    });
    const probeArgs = h.spawn.mock.calls[1]![1] as string[];
    expect(probeArgs.at(-1)).toContain('/uploads/s1-1?sig=read');
    expect(existsSync(local)).toBe(false);
  });

  it('numbers each re-render, so the player never shows a cached earlier cut', async () => {
    const patch = await renderStep(
      shortJob({ state: 'RENDER' }, { hook: HOOK, renders: 1 }),
      stepDeadline(),
    );
    expect(patch.object).toBe('uploads/s1-2');
    expect(patch.short!.renders).toBe(2);
  });

  it('fails and cleans up the temp file when the upload is refused', async () => {
    runs.render.onRun = writesFile;
    h.upload.mockRejectedValueOnce(new Error('403 Forbidden'));
    await expect(
      renderStep(shortJob({ state: 'RENDER' }, { hook: HOOK }), stepDeadline()),
    ).rejects.toThrow('403 Forbidden');
    expect(existsSync(join(tmpdir(), RENDER_FILE))).toBe(false);
  });

  it('fails when the render reads back without playable video', async () => {
    runs.probe = { stdout: JSON.stringify({ format: {}, streams: [] }) };
    await expect(
      renderStep(shortJob({ state: 'RENDER' }, { hook: HOOK }), stepDeadline()),
    ).rejects.toThrow('The rendered Short has no playable video.');
  });

  it('propagates an ffmpeg failure without uploading, and cleans up a partial file', async () => {
    runs.render = { stderr: 'Conversion failed!', code: 1, onRun: writesFile };
    await expect(
      renderStep(shortJob({ state: 'RENDER' }, { hook: HOOK }), stepDeadline()),
    ).rejects.toThrow('ffmpeg exited 1: Conversion failed!');
    expect(h.upload).not.toHaveBeenCalled();
    expect(existsSync(join(tmpdir(), RENDER_FILE))).toBe(false);
  });

  it('refuses a Short without a hook', async () => {
    await expect(renderStep(shortJob({ state: 'RENDER' }), stepDeadline())).rejects.toThrow(
      'The Short has no hook to cut.',
    );
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { floorTenth, lengthBounds, tenth } from '$lib/short';
import type { Chunk, Hook, Short } from '$lib/types';
import {
  LOUDNESS_TIMEOUT_MS,
  loudnessCurve,
  probe,
  renderShort,
  WINDOW_SEC,
  type LoudnessPoint,
} from './ffmpeg';
import { signedReadUrl, uploadFile } from './gcs';
import { fail, listChunks, ok, type JobDoc } from './jobs';
import { chatJson, stepDeadline } from './model';
import { stripNumerics } from './numerics';
import { isFiniteNumber, isString, shape } from './shape';
import { digestChunks } from './smart-pick';
import { agentInput, agentOutput, invokeAgent, type AgentSpan, type ChatMessage } from './tracing';

/**
 * Time the hook step keeps after the model: the loudness pass's whole time limit, plus signing its
 * URL and writing the job, so a slow model call can't push the step past its budget.
 */
const LOUDNESS_RESERVE_MS = LOUDNESS_TIMEOUT_MS + 5_000;

export const HOOK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['window', 'lengthSec', 'reason'],
  properties: {
    window: { type: 'integer' },
    lengthSec: { type: 'integer' },
    reason: { type: 'string' },
  },
} as const;

export type RawHook = { window: number; lengthSec: number; reason: string };

const RAW_HOOK = shape({ window: isFiniteNumber, lengthSec: isFiniteNumber, reason: isString });

export function isRawHook(value: unknown): value is RawHook {
  return RAW_HOOK(value);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export type HookContext = {
  songTitle: string;
  notes: string;
  sourceDurationSec: number;
  chunks: Chunk[];
  skipped: Short['skipped'];
};

export function buildHookMessages(ctx: HookContext): ChatMessage[] {
  const { min, max } = lengthBounds(ctx.sourceDurationSec);
  const rules = [
    'Pick the hook for a YouTube Short cut from this music video: the part a new listener should hear and see first, like the chorus, the drop, a riff, or the strongest visual moment.',
    `window: the index of the window the Short starts in. lengthSec: how long the Short runs from there, ${Math.floor(min)} to ${Math.floor(max)} seconds, ending where the phrase ends.`,
    'Each window lists what was seen and heard in it; integratedLufs is measured by ffmpeg, louder is closer to zero.',
    'reason: one sentence naming what in that window makes it the hook. No loudness, level, or tempo numbers.',
    ctx.skipped.length > 0
      ? 'skippedHooks were rejected. Pick a different window, or the same window with a clearly different length.'
      : '',
  ].filter(Boolean);
  const context = {
    songTitle: ctx.songTitle,
    artistNotes: ctx.notes || undefined,
    durationSec: Math.round(ctx.sourceDurationSec),
    windows: digestChunks(ctx.chunks).map((digest, i) => ({
      window: i,
      ...digest,
      integratedLufs: ctx.chunks[i]!.measurements.integratedLufs ?? undefined,
    })),
    skippedHooks: ctx.skipped.length > 0 ? ctx.skipped : undefined,
  };
  return [
    { role: 'system', content: rules.join('\n') },
    { role: 'user', content: JSON.stringify(context) },
  ];
}

/**
 * Holds the model's pick to real windows and the length bounds, and strips audio numbers. A late
 * window caps the length at what's left of the source from its start, so the cut can start inside
 * the window; only the last 15 s of a source start a full-length cut before their window.
 */
export function settleHook(raw: RawHook, ctx: HookContext): RawHook {
  const { min, max } = lengthBounds(ctx.sourceDurationSec);
  const window = clamp(Math.round(raw.window), 0, Math.max(0, ctx.chunks.length - 1));
  const room = floorTenth(ctx.sourceDurationSec - window * WINDOW_SEC);
  return {
    window,
    lengthSec: tenth(clamp(raw.lengthSec, min, Math.max(min, Math.min(max, room)))),
    reason: stripNumerics(raw.reason),
  };
}

const repeats = (hook: RawHook, skipped: Short['skipped']) =>
  skipped.some((s) => s.window === hook.window && s.lengthSec === hook.lengthSec);

/**
 * Asks the model for the hook, retrying once when it repeats a skipped one. Null when the reply
 * never parses; `hook: null` when the retry repeats too. With `span`, records the first request and
 * the settled hook on the agent span.
 */
export async function runHook(
  ctx: HookContext,
  deadline = stepDeadline(),
  span?: AgentSpan,
): Promise<{ hook: RawHook | null; ms: number } | null> {
  let ms = 0;
  let messages = buildHookMessages(ctx);
  if (span) agentInput(span, messages);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { value, ms: took } = await chatJson(
      messages,
      'hook_pick',
      HOOK_SCHEMA,
      isRawHook,
      deadline,
    );
    ms += took;
    if (!value) return null;
    const hook = settleHook(value, ctx);
    if (!repeats(hook, ctx.skipped)) {
      if (span) agentOutput(span, JSON.stringify(hook));
      return { hook, ms };
    }
    if (attempt === 1) return { hook: null, ms };
    messages = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(value) },
      { role: 'user', content: 'That repeats a skipped hook. Pick a different one.' },
    ];
  }
  return null;
}

/** Seconds on each side of a candidate start that are compared for a jump in loudness. */
export const RISE_SPAN_SEC = 2;
/** A rise under this many LU is no clear onset; the cut keeps the window's start. */
export const MIN_RISE_LU = 3;
/** Silence reads as -120 LUFS; flooring it stops a fade-in from outscoring a real hit. */
const FLOOR_LUFS = -70;

const meanOf = (points: LoudnessPoint[]) =>
  points.reduce((sum, p) => sum + Math.max(FLOOR_LUFS, p.m), 0) / points.length;

/** Mean loudness in the span after `t` minus the span before it; null at the curve's edges. */
function riseAt(curve: LoudnessPoint[], t: number): number | null {
  const before = curve.filter((p) => p.t > t - RISE_SPAN_SEC && p.t <= t);
  const after = curve.filter((p) => p.t > t && p.t <= t + RISE_SPAN_SEC);
  return before.length === 0 || after.length === 0 ? null : meanOf(after) - meanOf(before);
}

/**
 * Places the cut inside the model's window from ffmpeg's loudness: at the biggest jump in
 * momentary loudness (the hit the hook starts on), backed up to the quietest moment in the second
 * before it, so the Short opens on the gap and not mid-note. Without a clear jump, the window's
 * own start stands. Always leaves room for the full length.
 */
export function placeCut(
  curve: LoudnessPoint[],
  cut: { windowStart: number; windowEnd: number; lengthSec: number; sourceSec: number },
): number {
  const latest = Math.max(0, cut.sourceSec - cut.lengthSec);
  let onset = cut.windowStart;
  let best = MIN_RISE_LU;
  for (const { t } of curve.filter((p) => p.t >= cut.windowStart && p.t < cut.windowEnd)) {
    const rise = riseAt(curve, t);
    if (rise !== null && rise > best) {
      best = rise;
      onset = t;
    }
  }
  if (onset !== cut.windowStart) {
    const lead = curve.filter((p) => p.t >= onset - 1 && p.t <= onset);
    onset = lead.reduce((low, p) => (p.m < low.m ? p : low), lead.at(-1)!).t;
  }
  return Math.max(0, Math.min(tenth(onset), floorTenth(latest)));
}

/** HOOK step: the model picks the window and length, then ffmpeg's loudness places the start. */
export async function hookStep(job: JobDoc): Promise<Partial<JobDoc>> {
  const short = requireShort(job);
  const chunks = await listChunks(short.parentId);
  if (chunks.length === 0) throw new Error("The source video's analysis is gone.");
  const ctx: HookContext = {
    songTitle: job.songTitle,
    notes: job.notes,
    sourceDurationSec: short.sourceDurationSec,
    skipped: short.skipped,
    chunks,
  };
  const result = await invokeAgent('hook-pick', async (span) => {
    const picked = await runHook(ctx, stepDeadline() - LOUDNESS_RESERVE_MS, span);
    if (picked?.hook) span.setAttribute('short.window', picked.hook.window);
    return picked;
  });
  if (!result) throw new Error('The model reply did not parse as a hook.');
  const modelMs = short.modelMs + result.ms;
  // Re-driving the step would only replay the same refusals, so the artist decides what's next.
  if (!result.hook) {
    return {
      ...fail('HOOK', 'The model kept picking a skipped hook.'),
      short: { ...short, modelMs },
    };
  }
  const { window, lengthSec, reason } = result.hook;
  const windowStart = window * WINDOW_SEC;
  const windowEnd = Math.min(short.sourceDurationSec, windowStart + WINDOW_SEC);
  const scanFrom = Math.max(0, windowStart - RISE_SPAN_SEC - 1);
  const curve = await loudnessCurve(
    await signedReadUrl(requireSource(job)),
    scanFrom,
    Math.min(short.sourceDurationSec, windowEnd + RISE_SPAN_SEC) - scanFrom,
  );
  const startSec = placeCut(curve, {
    windowStart,
    windowEnd,
    lengthSec,
    sourceSec: short.sourceDurationSec,
  });
  const hook: Hook = { window, startSec, lengthSec, reason };
  return ok({ state: 'RENDER', short: { ...short, hook, modelMs } });
}

/** What the render step keeps after ffmpeg: the upload, then the read-back probe. */
const UPLOAD_TIMEOUT_MS = 20_000;
const READBACK_TIMEOUT_MS = 10_000;

/**
 * RENDER step: ffmpeg cuts and reframes the hook into a temp file, which goes to its own object and
 * is read back from storage before review. A new object per render means the player never shows a
 * cached earlier cut.
 */
export async function renderStep(job: JobDoc): Promise<Partial<JobDoc>> {
  const short = requireShort(job);
  if (!short.hook) throw new Error('The Short has no hook to cut.');
  const renders = short.renders + 1;
  const object = `uploads/${job.id}-${renders}`;
  const local = join(tmpdir(), `short-${job.id}-${renders}.mp4`);
  // One deadline across render, upload, and read-back, so the step can't outlast its budget.
  const renderBy = stepDeadline() - UPLOAD_TIMEOUT_MS - READBACK_TIMEOUT_MS;
  try {
    const source = await signedReadUrl(requireSource(job));
    await renderShort(
      source,
      local,
      { startSec: short.hook.startSec, lengthSec: short.hook.lengthSec, reframe: short.reframe },
      renderBy - Date.now(),
    );
    await uploadFile(local, object, 'video/mp4', UPLOAD_TIMEOUT_MS);
  } finally {
    // The container's disk is memory; a render left behind holds RAM until the instance stops.
    await rm(local, { force: true });
  }
  const probed = await probe(await signedReadUrl(object), READBACK_TIMEOUT_MS);
  if (!Number.isFinite(probed.durationSec) || probed.durationSec <= 0) {
    throw new Error('The rendered Short has no playable video.');
  }
  return ok({ state: 'REVIEW', probe: probed, short: { ...short, renders }, object });
}

function requireShort(job: JobDoc): Short {
  if (!job.short) throw new Error('Not a Short job.');
  return job.short;
}

function requireSource(job: JobDoc): string {
  if (!job.sourceObject) throw new Error('The Short has no source video.');
  return job.sourceObject;
}

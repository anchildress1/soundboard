// Spec 002 gate G2 (research R14). Never prints the API key, access token or endpoint DNS.
// Run from an isolated directory with `ai@7.0.148` and `@ai-sdk/google@4.0.102` installed:
// node g2.mjs <video>... with GEMINI_API_KEY and GCP_PROJECT_ID set. Writes result.json.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as ai from 'ai';
import { createGoogle } from '@ai-sdk/google';

const { GEMINI_API_KEY: apiKey, GCP_PROJECT_ID: project } = process.env;
const google = createGoogle({ apiKey });
const files = process.argv.slice(2);
const tmp = mkdtempSync(join(tmpdir(), 'g2-'));

// ---- Copied from src/lib/server/ai/chunk-analyst.ts and media/ffmpeg.ts (2026-10-24) ----------
const stringArray = { type: 'array', items: { type: 'string' } };
const CHUNK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['visual', 'music', 'qualityFlags'],
  properties: {
    visual: { type: 'string' },
    music: {
      type: 'object',
      additionalProperties: false,
      required: ['genre', 'tempoFeel', 'instrumentation', 'vocals', 'mood'],
      properties: {
        genre: stringArray,
        tempoFeel: { type: 'string' },
        instrumentation: stringArray,
        vocals: { type: 'string' },
        mood: stringArray,
      },
    },
    qualityFlags: stringArray,
  },
};
const RULES = [
  'Report what you see and hear in short plain phrases.',
  'visual: one or two sentences on imagery, setting, color, and editing pace.',
  'music: genre terms, tempo feel in words, instrumentation, vocal type, mood words.',
  'qualityFlags: unintended audible or visible problems only (dropouts, sync drift, encoding artifacts). Never the intended style: glitch, distortion, or lo-fi effects used on purpose are not problems. Empty if none.',
  'The measurements were taken with ffmpeg. Do not restate or estimate any loudness, level, or tempo numbers.',
  'Do not transcribe lyrics.',
];
const GEMMA_INSTRUCTIONS = [
  'Analyze one window of a music video: its audio and frames sampled across it.',
  ...RULES,
].join('\n');
// Only the first line changes: Gemini gets the window as one clip with its sound.
const GEMINI_INSTRUCTIONS = [
  'Analyze one window of a music video: watch and listen to the clip.',
  ...RULES,
].join('\n');
const MEASURE =
  'ebur128=peak=true:framelog=verbose,aformat=sample_fmts=s16,astats=measure_perchannel=none:measure_overall=Peak_level+Peak_count,silencedetect=n=-60dB:d=2';
const num = (m) => (m && Number.isFinite(Number(m[1])) ? Number(m[1]) : null);
const round = (n) => Math.round(n * 100) / 100;
function parseMeasurements(stderr, offsetSec, endSec) {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const peakLevelDb = num(/Peak level dB:\s*(-?[\d.]+|-?inf)/.exec(stderr));
  const peakCount = num(/Peak count:\s*([\d.]+)/.exec(stderr)) ?? 0;
  const silences = [];
  let open = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (s) open = Number(s[1]);
    if (e) {
      silences.push({
        start: round(offsetSec + (open ?? 0)),
        end: round(offsetSec + Number(e[1])),
      });
      open = null;
    }
  }
  if (open !== null) silences.push({ start: round(offsetSec + open), end: round(endSec) });
  return {
    integratedLufs: num(/I:\s*(-?[\d.]+|-?inf) LUFS/.exec(summary)),
    truePeakDbtp: num(/Peak:\s*(-?[\d.]+|-?inf) dBFS/.exec(summary)),
    clippedSamples: peakLevelDb !== null && peakLevelDb >= -0.01 ? Math.round(peakCount) : 0,
    peakLevelDb,
    silences,
  };
}
const chunkCount = (dur, win) => Math.max(1, Math.ceil((dur - 1) / win));
// ------------------------------------------------------------------------------------------------

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostats', ...args], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    const out = [],
      err = [],
      fd3 = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.stdio[3].on('data', (c) => fd3.push(c));
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve({ stdout: Buffer.concat(out), fd3: Buffer.concat(fd3), stderr });
      else reject(new Error(stderr.split('\n').slice(-3).join(' | ')));
    });
  });
}

function splitJpegs(stream) {
  const frames = [];
  let start = stream.indexOf(Buffer.from([0xff, 0xd8]));
  while (start !== -1) {
    const end = stream.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end === -1) break;
    frames.push(stream.subarray(start, end + 2));
    start = stream.indexOf(Buffer.from([0xff, 0xd8]), end + 2);
  }
  return frames;
}

/** Today's extractWindow, from a local file. */
async function gemmaWindow(file, startSec, durationSec) {
  const fps = (8 / durationSec).toFixed(4);
  const graph = [
    `[0:a:0]asplit=2[m][o]`,
    `[m]${MEASURE}[ms]`,
    `[o]aresample=16000,aformat=channel_layouts=mono[a]`,
    `[0:v:0]fps=${fps},scale=-2:360[v]`,
  ].join(';');
  const { stdout, stderr, fd3 } = await run([
    '-ss',
    startSec.toFixed(3),
    '-t',
    durationSec.toFixed(3),
    '-i',
    file,
    '-filter_complex',
    graph,
    '-map',
    '[ms]',
    '-f',
    'null',
    '-',
    '-map',
    '[a]',
    '-f',
    'wav',
    'pipe:1',
    '-map',
    '[v]',
    '-frames:v',
    '8',
    '-c:v',
    'mjpeg',
    '-q:v',
    '5',
    '-f',
    'image2pipe',
    'pipe:3',
  ]);
  return {
    wav: stdout,
    frames: splitJpegs(fd3),
    measurements: parseMeasurements(stderr, startSec, startSec + durationSec),
  };
}

/** Research R3 profile: fit 640x360, <=30 fps, maxrate 600k/1200k buffer, AAC 96k stereo 48 kHz, faststart. */
async function geminiClip(file, startSec, durationSec, path) {
  const t = performance.now();
  await run([
    '-y',
    '-ss',
    startSec.toFixed(3),
    '-t',
    durationSec.toFixed(3),
    '-i',
    file,
    '-vf',
    'scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2',
    '-fpsmax',
    '30',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-maxrate',
    '600k',
    '-bufsize',
    '1200k',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    path,
  ]);
  const cutMs = Math.round(performance.now() - t);
  const { stderr } = await run([
    '-ss',
    startSec.toFixed(3),
    '-t',
    durationSec.toFixed(3),
    '-i',
    file,
    '-filter_complex',
    `[0:a:0]${MEASURE}`,
    '-f',
    'null',
    '-',
  ]);
  const bytes = statSync(path).size;
  if (bytes > 8_000_000) throw new Error(`clip ${bytes} bytes over 8,000,000`);
  return {
    bytes,
    cutMs,
    measurements: parseMeasurements(stderr, startSec, startSec + durationSec),
  };
}

const context = (startSec, durationSec, measurements) =>
  JSON.stringify({
    songTitle: 'Untitled',
    window: { startSec, durationSec },
    ffmpeg: measurements,
  });

// ---- Gemma on the Vertex endpoint, exactly as the app calls it today --------------------------
const gcloud = (...a) => execFileSync('gcloud', a, { encoding: 'utf8' }).trim();
// `list` returns the bare endpoint ID as `name`; `describe` returns the full resource path the invoke URL needs.
const endpointId = gcloud(
  'ai',
  'endpoints',
  'list',
  '--region',
  'us-central1',
  '--project',
  project,
  '--filter',
  'displayName=soundboard-model',
  '--format',
  'value(name)',
);
const [dns, name] = gcloud(
  'ai',
  'endpoints',
  'describe',
  endpointId,
  '--region',
  'us-central1',
  '--project',
  project,
  '--format',
  'value(dedicatedEndpointDns,name)',
).split(/\s+/);
const gemmaUrl = `https://${dns}/v1/${name}/invoke`;
const token = () => gcloud('auth', 'print-access-token');

async function gemmaReady() {
  const started = Date.now();
  for (;;) {
    const r = await fetch(`${gemmaUrl}/health`, {
      headers: { authorization: `Bearer ${token()}` },
    }).catch((e) => ({ ok: false, status: e.message }));
    if (r.ok) return Math.round((Date.now() - started) / 1000);
    // A 4xx other than the scale-from-zero 429 is a harness bug, not a cold model.
    if (typeof r.status === 'number' && r.status >= 400 && r.status < 500 && r.status !== 429)
      throw new Error(`Gemma health ${r.status}`);
    console.error(`gemma health ${r.status} at ${Math.round((Date.now() - started) / 1000)}s`);
    if (Date.now() - started > 25 * 60_000)
      throw new Error(`Gemma not ready after 25 min (last ${r.status})`);
    await new Promise((res) => setTimeout(res, 20_000));
  }
}

async function gemma(window, startSec, durationSec) {
  const messages = [
    { role: 'system', content: GEMMA_INSTRUCTIONS },
    {
      role: 'user',
      content: [
        { type: 'text', text: context(startSec, durationSec, window.measurements) },
        ...window.frames.map((f) => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${f.toString('base64')}` },
        })),
        {
          type: 'input_audio',
          input_audio: { data: window.wav.toString('base64'), format: 'wav' },
        },
      ],
    },
  ];
  const t = performance.now();
  const r = await fetch(`${gemmaUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
    body: JSON.stringify({
      model: 'gemma-4-12b-it',
      temperature: 0.2,
      max_tokens: 2048,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'chunk_analysis', strict: true, schema: CHUNK_SCHEMA },
      },
      messages,
    }),
  });
  const ms = Math.round(performance.now() - t);
  if (!r.ok) return { ms, error: `${r.status} ${(await r.text()).slice(0, 200)}` };
  const body = await r.json();
  const content = body.choices?.[0]?.message?.content ?? '';
  let output = null;
  try {
    output = JSON.parse(content);
  } catch {
    /* raw kept */
  }
  return { ms, usage: body.usage, output, raw: output ? undefined : content };
}

// ---- Gemini configurations (research R14) ------------------------------------------------------
const CONFIGS = {
  A: { model: 'gemini-3.8-flash', low: true, thinkingLevel: 'low', maxOutputTokens: 2048 },
  B: { model: 'gemini-3.8-flash', low: false, thinkingLevel: 'medium', maxOutputTokens: 8192 },
  C: { model: 'gemini-4-argon', low: false, thinkingLevel: 'medium', maxOutputTokens: 8192 },
};

async function gemini(cfg, clip, startSec, durationSec, measurements) {
  const t = performance.now();
  try {
    const r = await ai.generateText({
      model: google.interactions(cfg.model),
      instructions: GEMINI_INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: context(startSec, durationSec, measurements) },
            { type: 'file', mediaType: 'video/mp4', data: readFileSync(clip) },
          ],
        },
      ],
      output: ai.Output.object({ schema: ai.jsonSchema(CHUNK_SCHEMA) }),
      maxOutputTokens: cfg.maxOutputTokens,
      maxRetries: 0,
      telemetry: { isEnabled: false },
      providerOptions: {
        google: {
          store: false,
          thinkingLevel: cfg.thinkingLevel,
          ...(cfg.low ? { mediaResolution: 'low' } : {}),
        },
      },
    });
    return {
      ms: Math.round(performance.now() - t),
      finish: r.finishReason,
      usage: {
        input: r.usage.inputTokens,
        output: r.usage.outputTokens,
        reasoning: r.usage.outputTokenDetails?.reasoningTokens,
      },
      output: r.output,
    };
  } catch (e) {
    return {
      ms: Math.round(performance.now() - t),
      error: `${e.name} ${e.statusCode ?? ''} ${String(e.message).slice(0, 200)}`,
      raw: e.text,
    };
  }
}

const probe = (f) =>
  Number(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
      { encoding: 'utf8' },
    ),
  );
const out = { date: new Date().toISOString(), configs: CONFIGS, videos: [] };
try {
  out.gemmaWakeSec = await gemmaReady();
  for (const file of files) {
    const duration = probe(file);
    const video = { file: basename(file), duration: round(duration), gemma: [], gemini: [] };
    for (let i = 0; i < chunkCount(duration, 29.5); i++) {
      const start = i * 29.5,
        len = Math.min(29.5, duration - start);
      const w = await gemmaWindow(file, start, len);
      video.gemma.push({
        index: i,
        start,
        len: round(len),
        frames: w.frames.length,
        ...(await gemma(w, start, len)),
      });
    }
    for (let i = 0; i < chunkCount(duration, 60); i++) {
      const start = i * 60,
        len = Math.min(60, duration - start);
      const path = join(tmp, `${i}.mp4`);
      const clip = await geminiClip(file, start, len, path);
      const row = { index: i, start, len: round(len), bytes: clip.bytes, cutMs: clip.cutMs };
      for (const [k, cfg] of Object.entries(CONFIGS))
        row[k] = await gemini(cfg, path, start, len, clip.measurements);
      rmSync(path);
      video.gemini.push(row);
    }
    out.videos.push(video);
    writeFileSync('result.json', JSON.stringify(out, null, 2));
    console.error(`done ${basename(file)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync('result.json', JSON.stringify(out, null, 2));
}

// Pure fixtures and fakes for the pipeline tests; the module mocks stay in the test file.
import { EventEmitter } from 'node:events';
import type { JobDoc } from '$lib/server/jobs';

export const SYNTHWAVE = '#synthwave';
export const RETROWAVE = '#retrowave';
export const ARTIST = 'Flies Like Robots';
export const SESSION_URI = 'https://upload.example/s1';

export type Run = { stdout?: string | Buffer; stderr?: string; fd3?: Buffer; code?: number };

// ---- ffmpeg / ffprobe ----

export const MEASURE_STDERR = [
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

export const probeJson = (durationSec: number, audio = true) =>
  JSON.stringify({
    format: { duration: String(durationSec) },
    streams: [
      { codec_type: 'video', width: 1920, height: 1080 },
      ...(audio ? [{ codec_type: 'audio' }] : []),
    ],
  });

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0xff, 0xd9]);

export function child(run: Run) {
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

export const ANALYSIS = {
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

export const RAW_PICK = {
  title: 'PeekaBoo (Official Video)',
  description: 'A night drive through the city. #synthwave',
  hashtags: [SYNTHWAVE, RETROWAVE, '#newmusic'],
  tags: ['synthwave', 'PeekaBoo', ARTIST],
  brandCheck: 'Keeps the channel naming pattern.',
  why: { title: 'Matches recent titles.', description: 'Short and plain.', tags: 'Genre first.' },
  bandcamp: { about: 'Bandcamp about.', credits: 'Written by Nathan.' },
};

export type Handler = {
  test: RegExp;
  reply: (url: string, init: RequestInit) => Response | Promise<Response>;
};

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

export const headers = (init: RequestInit) => (init.headers ?? {}) as Record<string, string>;
export const completion = (content: string) =>
  json({
    choices: [{ message: { content, reasoning_content: 'thinking' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

export function defaultHandlers(): Handler[] {
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
      reply: () => new Response('', { status: 200, headers: { location: SESSION_URI } }),
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

export function jobDoc(patch: Partial<JobDoc> = {}): JobDoc {
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
    shortId: null,
    short: null,
    sourceObject: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

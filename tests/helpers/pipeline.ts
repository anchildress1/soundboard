// Pure fixtures and fakes for the pipeline tests; the module mocks stay in the test file.
import { EventEmitter } from 'node:events';
import type { BrandGuide, ProposalSources, SourceSummary, VoiceRules } from '#lib/brand.js';
import type { JobDoc } from '#lib/server/jobs/jobs.js';
import { jobRow } from '#lib/server/jobs/rows.js';
import { seed, type Seed } from './db';
import { interaction } from './gemini';
import { NATHAN_VOICE_RULES } from './voice';

export { NATHAN_VOICE_RULES };

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

// ---- network: Gemini, YouTube, GCS signed URLs ----

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

/**
 * Gemini answers the analyst's schema with `ANALYSIS` and every other schema with `RAW_PICK`. Busy,
 * per-day, 503 and 400 replies come from `./gemini`.
 */
export function defaultHandlers(): Handler[] {
  return [
    {
      test: /generativelanguage\.googleapis\.com\/v1beta\/interactions$/,
      reply: (_url, init) => {
        const body = JSON.parse(String(init.body)) as { response_format: unknown };
        const analyst = JSON.stringify(body.response_format).includes('"qualityFlags"');
        return interaction(JSON.stringify(analyst ? ANALYSIS : RAW_PICK));
      },
    },
    {
      test: /youtube\/v3\/channels\?/,
      // A bearer read (`mine=true`) answers with the grant's own channel; a key read, with A's.
      reply: (_url, init) => {
        const id =
          headers(init).authorization === `Bearer access:${REFRESH_C}` ? CHANNEL_C : CHANNEL_A;
        return json({
          items: [
            {
              id,
              snippet: { customUrl: '@flieslikerobots' },
              statistics: { videoCount: '12', subscriberCount: '300' },
              contentDetails: { relatedPlaylists: { uploads: `UU${id}` } },
            },
          ],
        });
      },
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
      reply: (url) => {
        const params = new URL(url).searchParams;
        const id = params.get('id') ?? '';
        // The upload read-back asks for status; the owner's identity read only for snippets.
        if (params.get('part')?.includes('status')) {
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

// ---- users ----

/** The e2e KMS fake's ciphertext format, so one fixture decrypts in unit tests and the E2E build. */
export const sealed = (plain: string) => Buffer.from(`e2e-kms:${plain}`).toString('base64');

/** Nathan's profile as migration 0005 inserts it. */
export const ARTIST_A = {
  id: 'flr',
  name: ARTIST,
  bandcampUrl: 'https://flieslikerobots.bandcamp.com',
  contactLine: 'Contact at flieslikerobots@gmail.com.',
} as const;
/** A non-Nathan profile: generic voice, its own Bandcamp URL and contact line. */
export const ARTIST_C = {
  id: 'artist-c',
  name: 'Test Artist',
  bandcampUrl: 'https://test-artist.bandcamp.com',
  contactLine: 'Booking: test@example.com',
} as const;

const CARRIED = { uploads: 0, drafts: 0, edits: 0, approvals: 0, carriedOver: true };

/** An approved guide row for `artistId`, carried over unless `sources` says otherwise. */
export function approvedGuide(
  artistId: string,
  kind: 'voice' | 'brand',
  body: VoiceRules | BrandGuide,
  sources: SourceSummary = CARRIED,
) {
  return {
    artistId,
    kind,
    status: 'approved' as const,
    body,
    sources,
    proposedAt: new Date(Date.now() - 60_000),
    approvedAt: new Date(Date.now() - 60_000),
  };
}

/** A pending proposal row for `artistId`, read at `proposedAt` through the grant from `grantAt`. */
export function pendingProposal(
  artistId: string,
  kind: 'voice' | 'brand',
  body: VoiceRules | BrandGuide,
  {
    sources = { uploads: [], drafts: [], edits: 0, approvals: 0, thin: false },
    proposedAt = new Date(Date.now() - 60_000),
    grantAt = null,
  }: { sources?: ProposalSources; proposedAt?: Date; grantAt?: Date | null } = {},
) {
  return { artistId, kind, status: 'proposed' as const, body, sources, proposedAt, grantAt };
}

/** Linked to Flies Like Robots, with YouTube connected to the FLR channel. */
export const USER_A = {
  uid: 'uid-a',
  sid: 'sid-a',
  email: 'a@example.com',
  artistId: ARTIST_A.id,
  artist: ARTIST_A,
} as const;
/** Invited with no artist profile and no connection. */
export const USER_B = {
  uid: 'uid-b',
  sid: 'sid-b',
  email: 'b@example.com',
  artistId: null,
  artist: null,
} as const;
/** Linked to a non-Nathan profile, with YouTube connected to its own channel. */
export const USER_C = {
  uid: 'uid-c',
  sid: 'sid-c',
  email: 'c@example.com',
  artistId: ARTIST_C.id,
  artist: ARTIST_C,
} as const;
export const CHANNEL_A = 'UCflr';
export const REFRESH_A = 'refresh-a';
export const CHANNEL_C = 'UCtest';
export const REFRESH_C = 'refresh-c';

const connected = (uid: string, channelId: string, channelTitle: string, refresh: string) => ({
  uid,
  status: 'connected' as const,
  channelId,
  channelTitle,
  scopes: ['openid', 'email'],
  tokenCiphertext: sealed(refresh),
  updatedAt: new Date(0),
});

/** A, B and C as invited, signed-up users; A's and C's YouTube grants are connected; Nathan's voice. */
export const USERS = {
  artists: [ARTIST_A, ARTIST_C].map((artist) => ({ ...artist })),
  artistGuides: [approvedGuide(ARTIST_A.id, 'voice', { rules: NATHAN_VOICE_RULES })],
  users: [USER_A, USER_B, USER_C].map(({ uid, email, artistId }) => ({ uid, email, artistId })),
  connections: [
    connected(USER_A.uid, CHANNEL_A, ARTIST, REFRESH_A),
    connected(USER_C.uid, CHANNEL_C, ARTIST_C.name, REFRESH_C),
  ],
} satisfies Seed;

/** Patch for a job owned by A, on the FLR artist. */
export const A_JOB = { ownerUid: USER_A.uid, artistId: USER_A.artistId } as const;
/** Patch for a job owned by C, on C's profile. */
export const C_JOB = { ownerUid: USER_C.uid, artistId: USER_C.artistId } as const;

// ---- jobs ----

export function jobDoc(patch: Partial<JobDoc> = {}): JobDoc {
  return {
    id: 'j1',
    state: 'PREP',
    ownerUid: USER_B.uid,
    artistId: null,
    parentId: null,
    destination: null,
    songTitle: 'PeekaBoo',
    notes: '',
    filename: 'peekaboo.mp4',
    contentType: 'video/mp4',
    object: 'uploads/j1',
    videoUpload: null,
    probe: null,
    measurements: null,
    chunkCount: 0,
    chunkIndex: 0,
    failedState: null,
    error: null,
    uploadProgress: null,
    videoId: null,
    consecutiveFailures: 0,
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
    uploadStartedAt: null,
    finalChunkAt: null,
    limitUntil: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

/** Inserts `jobDoc(patch)`; its owner must already be seeded. */
export async function seedJob(patch: Partial<JobDoc> = {}): Promise<JobDoc> {
  const doc = jobDoc(patch);
  await seed({
    jobs: [jobRow(doc)],
    jobAudience: doc.audience
      ? [{ jobId: doc.id, retrievedAt: new Date(doc.audience.retrievedAt), evidence: doc.audience }]
      : [],
  });
  return doc;
}

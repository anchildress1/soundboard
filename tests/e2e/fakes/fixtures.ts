// Users and jobs the E2E server starts with: user A (linked to FLR, YouTube connected) owns every
// job but B's and C's; user B is invited with no profile; user C has a non-Nathan profile and its
// own connected channel. One more user per broken YouTube status backs the Connections page, an
// upload user with a profile creates its own jobs through `/new`, and each Playwright project has its own
// no-profile, rename and guide users, since those tests write. Each test owns its job IDs, so parallel
// tests and both Playwright projects never share mutable state.
import type { JobDoc } from '#lib/server/jobs/jobs.js';
import { jobRow } from '#lib/server/jobs/rows.js';
import type { Chunk, Pick, Short } from '#lib/types.js';
import type { Seed } from '../../helpers/db';
import {
  A_JOB,
  approvedGuide,
  ARTIST_A,
  ARTIST_C,
  C_JOB,
  CHANNEL_A,
  CHANNEL_C,
  jobDoc,
  pendingProposal,
  USER_B,
  USERS,
} from '../../helpers/pipeline';

/** Playwright's project names, and the device each project's own users are named after. */
const PROJECTS = ['chromium', 'mobile'] as const;
const DEVICE = { chromium: 'desktop', mobile: 'pixel' } as const;

const SYNTHWAVE = '#synthwave';
const RETROWAVE = '#retrowave';

const PROBE = { durationSec: 140, width: 1920, height: 1080, hasAudio: true };

const PICK: Pick = {
  version: 1,
  title: 'PeekaBoo (Official Video)',
  description: 'Night drive in a borrowed car.\n\n#synthwave #retrowave',
  hashtags: [SYNTHWAVE, RETROWAVE],
  tags: ['synthwave', 'Flies Like Robots'],
  flags: [],
  brandCheck: '',
  why: { title: 'Matches the genre.', description: 'Plain.', tags: 'Genre first.' },
  bandcamp: { about: 'A night drive.', credits: 'Written by Flies Like Robots.' },
  artistName: ARTIST_A.name,
  modelMs: 12_000,
};

/** C's pick: its own name as the fixed tag, and its contact line closing the body. */
const C_PICK: Pick = {
  ...PICK,
  description: 'Night drive in a borrowed car.\nBooking: test@example.com\n\n#synthwave #retrowave',
  tags: [ARTIST_C.name, 'synthwave'],
  bandcamp: { about: 'A night drive.', credits: 'Booking: test@example.com' },
  artistName: ARTIST_C.name,
};

const chunk = (index: number): Chunk => ({
  index,
  startSec: index * 60,
  durationSec: index === 2 ? 20 : 60,
  measurements: {
    integratedLufs: -14,
    truePeakDbtp: -1.2,
    peakLevelDb: -1.2,
    clippedSamples: 0,
    silences: [],
  },
  analysis: {
    visual: 'Neon streets at night.',
    music: {
      genre: ['synthwave'],
      tempoFeel: 'driving',
      instrumentation: ['analog synth'],
      vocals: 'male lead',
      mood: ['nostalgic'],
    },
    qualityFlags: [],
  },
  raw: null,
  modelMs: 4000,
});

function job(id: string, patch: Partial<JobDoc> = {}): JobDoc {
  return jobDoc({
    id,
    ...A_JOB,
    state: 'REVIEW',
    object: `uploads/${id}`,
    probe: PROBE,
    // chunkCount(140) under 60 s windows; any other count sends an analyzing job back to prep.
    chunkCount: 3,
    chunkIndex: 3,
    consecutiveFailures: 0,
    hashtagCandidates: [SYNTHWAVE, RETROWAVE],
    audience: {
      retrievedAt: Date.now(),
      query: 'synthwave music video',
      candidateLists: [
        {
          source: 'genre',
          ref: 'G1',
          videoId: 'peer',
          title: 'Peer release',
          hashtags: [SYNTHWAVE, RETROWAVE],
          tags: [{ tag: 'synthwave' }],
        },
      ],
      top: [],
    },
    pickVersion: 1,
    ...patch,
  });
}

const SHORT: Short = {
  sourceDurationSec: 140,
  reframe: 'blur',
  hook: { window: 1, startSec: 70, lengthSec: 30, reason: 'The chorus lands with the full band.' },
  skipped: [],
  renders: 1,
  modelMs: 6000,
};

/** A video in review with its chunks and pick. */
const reviewed = (id: string) => ({ job: job(id), pick: PICK, chunks: [0, 1, 2].map(chunk) });

/** A video already on YouTube: the Short is offered only once the release is approved. */
const uploaded = (id: string, patch: Partial<JobDoc> = {}) => ({
  ...reviewed(id),
  job: job(id, {
    state: 'VERIFIED',
    destination: { channelId: CHANNEL_A, channelTitle: 'Flies Like Robots' },
    finalFields: {
      title: PICK.title,
      description: PICK.description,
      hashtags: PICK.hashtags,
      tags: PICK.tags,
    },
    videoId: `${id}-video`,
    ...patch,
  }),
});

const JOBS: { job: JobDoc; pick: Pick | null; chunks: Chunk[] }[] = [
  ...['chromium', 'mobile'].flatMap((project) => {
    const id = `e2e-short-paused-${project}`;
    return [
      uploaded(id, { shortId: `${id}-short` }),
      {
        job: job(`${id}-short`, {
          parentId: id,
          short: SHORT,
          state: 'PUBLISHING',
          destination: { channelId: CHANNEL_A, channelTitle: 'Flies Like Robots' },
          finalFields: {
            title: PICK.title,
            description: PICK.description,
            hashtags: PICK.hashtags,
            tags: PICK.tags,
          },
          uploadStartedAt: 1,
          finalChunkAt: 2,
        }),
        pick: PICK,
        chunks: [],
      },
    ];
  }),
  reviewed('e2e-tabs'),
  ...['e2e-make-chromium', 'e2e-make-mobile'].map((id) => uploaded(id)),
  uploaded('e2e-cut', { shortId: 'e2e-cut-short' }),
  {
    job: job('e2e-cut-short', {
      parentId: 'e2e-cut',
      filename: 'peekaboo (Short).mp4',
      object: 'uploads/e2e-cut-short-1',
      probe: { durationSec: 30, width: 1080, height: 1920, hasAudio: true },
      chunkCount: 0,
      chunkIndex: 0,
      sourceObject: 'uploads/e2e-cut',
      short: SHORT,
    }),
    pick: PICK,
    chunks: [],
  },
  {
    job: job('e2e-b-review', { ownerUid: USER_B.uid, artistId: null, songTitle: 'Vaporgram' }),
    pick: { ...PICK, title: 'Vaporgram', tags: ['synthwave'], artistName: null },
    chunks: [0, 1, 2].map(chunk),
  },
  ...PROJECTS.map((project) => ({
    job: job(`e2e-c-review-${project}`, { ...C_JOB, songTitle: 'Vaporgram' }),
    pick: C_PICK,
    chunks: [0, 1, 2].map(chunk),
  })),
  // C's release already on its own channel, read-only: it backs the Bandcamp screen check.
  {
    job: job('e2e-c-done', {
      ...C_JOB,
      songTitle: 'Vaporgram',
      state: 'VERIFIED',
      destination: { channelId: CHANNEL_C, channelTitle: ARTIST_C.name },
      finalFields: {
        title: C_PICK.title,
        description: C_PICK.description,
        hashtags: C_PICK.hashtags,
        tags: C_PICK.tags,
      },
      videoId: 'e2e-c-done-video',
    }),
    pick: C_PICK,
    chunks: [0, 1, 2].map(chunk),
  },
  { ...reviewed('e2e-expired'), job: job('e2e-expired', { songTitle: 'Gone Song' }) },
  // Analyzed in 29.5 s windows before spec 002: five for 140 s, not chunkCount(140) = 3.
  uploaded('e2e-stale', { chunkCount: 5, chunkIndex: 5 }),
  // Paused with the upload outcome unknown: its steps make no YouTube call.
  ...['e2e-paused-chromium', 'e2e-paused-mobile'].map((id) => ({
    job: job(id, {
      state: 'PUBLISHING',
      destination: { channelId: CHANNEL_A, channelTitle: 'Flies Like Robots' },
      finalFields: {
        title: PICK.title,
        description: PICK.description,
        hashtags: PICK.hashtags,
        tags: PICK.tags,
      },
      uploadStartedAt: 1,
      finalChunkAt: 2,
    }),
    pick: PICK,
    chunks: [0, 1, 2].map(chunk),
  })),
  ...[
    'e2e-analyzing',
    'e2e-analyze-chromium',
    'e2e-analyze-mobile',
    'e2e-signout-chromium',
    'e2e-signout-mobile',
  ].map((id) => ({
    job: job(id, { state: 'ANALYZE', chunkIndex: 1, pickVersion: null }),
    pick: null,
    chunks: [chunk(0)],
  })),
];

// Picking for user C: the identity read goes through C's grant (tests/e2e/fakes/youtube.ts), and
// the cached genre search means no search call.
const PICKING = ['e2e-pick-chromium', 'e2e-pick-mobile'].map((id) => ({
  job: job(id, {
    ...C_JOB,
    songTitle: 'Vaporgram',
    state: 'PICK',
    pickVersion: null,
  }),
  pick: null,
  chunks: [0, 1, 2].map(chunk),
}));

/** One signed-up user per YouTube status that isn't connected, uid `uid-<status>`. */
export const BROKEN_STATUSES = ['missing_scopes', 'no_channel', 'revoked'] as const;
const broken = BROKEN_STATUSES.map((status) => ({
  status,
  uid: `uid-${status}`,
  email: `${status}@example.com`,
}));

/** Each project's own users for tests that write: one with no profile, one that renames its own. */
const perProject = PROJECTS.flatMap((project) => {
  const device = DEVICE[project];
  return [
    { user: { uid: `uid-new-${device}`, email: `new-${device}@example.com` }, artist: null },
    {
      user: {
        uid: `uid-rename-${device}`,
        email: `rename-${device}@example.com`,
        artistId: `artist-r${device[0]}`,
      },
      artist: {
        id: `artist-r${device[0]}`,
        name: 'Rename Band',
        bandcampUrl: 'https://rename-band.bandcamp.com',
        contactLine: 'Booking: rename@example.com',
      },
    },
  ];
});

/**
 * Each project's own guide users: `brand` and `race` hold one pending voice proposal (one approves
 * it, two tabs race on the other); `propose` has no guides and C's connected channel.
 */
const GUIDE_ROLES = { brand: 'b', race: 'rc', propose: 'p' } as const;
const guideUsers = PROJECTS.flatMap((project) => {
  const device = DEVICE[project];
  return Object.entries(GUIDE_ROLES).map(([role, id]) => ({
    uid: `uid-${role}-${device}`,
    email: `${role}-${device}@example.com`,
    artistId: `artist-${id}${device[0]}`,
  }));
});
const proposers = guideUsers.filter(({ uid }) => uid.startsWith('uid-propose-'));
const reviewers = guideUsers.filter((user) => !proposers.includes(user));

/** Nathan's brand guide as 004 approved it; migration 0006 already carried his voice over. */
export const NATHAN_BRAND = {
  statement: 'Plain titles, a short story, then the credits.',
  keep: ['Song title alone in the title'],
  fix: ['One links block'],
  drop: ['All-caps titles'],
};

/** Every row the E2E database starts with, in `seed()` order. */
export const SEED: Seed = {
  // The real migrations already inserted `flr`.
  artists: [
    ...USERS.artists.filter((artist) => artist.id !== ARTIST_A.id),
    { id: 'artist-upload', name: 'Upload Band' },
    ...perProject.flatMap(({ artist }) => (artist ? [artist] : [])),
    ...guideUsers.map(({ artistId }) => ({ id: artistId, name: 'Guide Band' })),
  ],
  users: [
    ...USERS.users,
    ...broken.map(({ uid, email }) => ({ uid, email })),
    { uid: 'uid-upload', email: 'upload@example.com', artistId: 'artist-upload' },
    ...perProject.map(({ user }) => user),
    ...guideUsers,
  ],
  connections: [
    ...USERS.connections,
    // Same grant and channel as C, so each project proposes on its own claim.
    ...proposers.map(({ uid }) => ({ ...USERS.connections[1]!, uid })),
    ...broken.map(({ uid, status }) => ({
      uid,
      status,
      channelId: null,
      channelTitle: null,
      scopes: ['openid', 'email'],
      tokenCiphertext: null,
      updatedAt: new Date(0),
    })),
  ],
  jobs: [...JOBS, ...PICKING].map(({ job, pick, chunks }) => ({
    ...jobRow(job),
    picks: pick ? [{ ...pick, skipped: false }] : [],
    chunks,
  })),
  jobAudience: [...JOBS, ...PICKING].flatMap(({ job }) =>
    job.audience
      ? [{ jobId: job.id, retrievedAt: new Date(job.audience.retrievedAt), evidence: job.audience }]
      : [],
  ),
  artistGuides: [
    approvedGuide(ARTIST_A.id, 'brand', NATHAN_BRAND, {
      uploads: 30,
      drafts: 0,
      edits: 0,
      approvals: 0,
      carriedOver: true,
    }),
    ...reviewers.map(({ artistId }) =>
      pendingProposal(
        artistId,
        'voice',
        { rules: ['Short, dry sentences.', 'One aside per description.'] },
        { sources: { uploads: [], drafts: [], edits: 2, approvals: 1, thin: true } },
      ),
    ),
  ],
};

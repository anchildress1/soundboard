// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { researchRuns } from '#lib/server/core/schema.js';
import { getJob } from '#lib/server/jobs/jobs.js';
import { jobRow } from '#lib/server/jobs/rows.js';
import { clearStatsCache } from '#lib/server/platforms/youtube/youtube.js';
import { load as layoutLoad } from '#src/routes/+layout.server.js';
import { load as homeLoad } from '#src/routes/+page.server.js';
import { load as jobLoad } from '#src/routes/jobs/[id]/+page.server.js';
import { load as brandLoad } from '#src/routes/brand/+page.server.js';
import { load as connectionsLoad } from '#src/routes/connections/+page.server.js';
import { load as settingsLoad } from '#src/routes/settings/+page.server.js';
import { GET as getJobApi } from '#src/routes/api/jobs/[id]/+server.js';
import { POST as approve } from '#src/routes/api/jobs/[id]/approve/+server.js';
import { POST as confirmUpload } from '#src/routes/api/jobs/[id]/confirm-upload/+server.js';
import { POST as discard } from '#src/routes/api/jobs/[id]/discard/+server.js';
import { POST as recut } from '#src/routes/api/jobs/[id]/recut/+server.js';
import { POST as rerun } from '#src/routes/api/jobs/[id]/rerun/+server.js';
import { POST as makeShort } from '#src/routes/api/jobs/[id]/short/+server.js';
import { POST as step } from '#src/routes/api/jobs/[id]/step/+server.js';
import { POST as uploadSession } from '#src/routes/api/jobs/[id]/upload-session/+server.js';
import { KeyManagementServiceClient } from '../../e2e/fakes/kms';
import { seed, truncate } from '../../helpers/db';
import {
  A_JOB,
  ARTIST_C,
  C_JOB,
  CHANNEL_A,
  CHANNEL_C,
  jobDoc,
  sealed,
  seedJob,
  USER_A,
  USER_B,
  USER_C,
  USERS,
} from '../../helpers/pipeline';

// One process serving A, then C, then A: nothing one user saw may leak into the next request.

const h = vi.hoisted(() => ({ createResumableUpload: vi.fn() }));

vi.mock('@google-cloud/kms', () => import('../../e2e/fakes/kms'));
vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      return {
        file: (object: string) => ({
          getSignedUrl: async () => [`https://storage.googleapis.com/${name}/${object}?sig=read`],
          exists: async () => [true],
          getMetadata: async () => [{ size: '10', contentType: 'video/mp4' }],
          createResumableUpload: h.createResumableUpload,
        }),
      };
    }
  },
}));

type User = typeof USER_A | typeof USER_B | typeof USER_C;
type Layout = { channel: { handle: string } | null };
type Home = { jobs: { id: string }[] };
type JobPage = { view: { job: { id: string } }; playbackUrl: string | null };
type Connections = { youtube: { channelTitle: string | null } | null };

const CHANNEL_B = 'UCb';
const PROBE = { durationSec: 180, width: 1920, height: 1080, hasAudio: true };

const event = (user: User, id?: string, body: unknown = {}) =>
  ({
    locals: { user },
    params: id ? { id } : {},
    url: new URL('http://localhost/connections'),
    request: new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) }),
  }) as never;
const status = (error: unknown) => (isHttpError(error) ? error.status : error);

const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  vi.stubEnv('YOUTUBE_API_KEY', 'key');
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  resetClients();
  clearStatsCache();
  // The channel read answers with a handle named after the requested channel ID.
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/channels')) return Response.json({ items: [] });
    return Response.json({
      items: [
        {
          snippet: { customUrl: `@${url.searchParams.get('id')}` },
          statistics: { videoCount: '1', subscriberCount: '1' },
          contentDetails: { relatedPlaylists: { uploads: 'UU' } },
        },
      ],
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  await truncate();
  await seed(USERS);
  await seed({
    connections: [
      {
        uid: USER_B.uid,
        status: 'connected',
        channelId: CHANNEL_B,
        channelTitle: 'B',
        scopes: [],
        tokenCiphertext: 'c2VhbGVk',
        updatedAt: new Date(0),
      },
    ],
  });
  for (const [id, owner] of [
    ['a', A_JOB],
    ['b', C_JOB],
  ] as const) {
    const video = jobDoc({
      id,
      ...owner,
      state: 'VERIFIED',
      object: `uploads/${id}`,
      probe: PROBE,
      chunkCount: 3,
      pickVersion: 1,
    });
    const artistName = owner === A_JOB ? 'Flies Like Robots' : ARTIST_C.name;
    const picks = [{ version: 1, title: id, tags: [artistName], artistName }];
    await seed({ jobs: [{ ...jobRow(video), picks }] });
    // A rendered Short of each user's video, in review, so its playback URL is signed.
    await seedJob({
      id: `${id}s`,
      ...owner,
      state: 'REVIEW',
      parentId: id,
      object: `uploads/${id}s-1`,
      sourceObject: `uploads/${id}`,
      pickVersion: 1,
      short: {
        sourceDurationSec: 180,
        reframe: 'blur',
        hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'x' },
        skipped: [],
        renders: 1,
        modelMs: 1,
      },
    });
  }
});

/** Every job API a user can aim at another user's video or Short. */
const FOREIGN_CALLS: [string, (user: User, video: string, short: string) => unknown][] = [
  ['GET job', (user, video) => getJobApi(event(user, video))],
  ['GET Short', (user, _video, short) => getJobApi(event(user, short))],
  ['step', (user, video) => step(event(user, video))],
  ['rerun', (user, video) => rerun(event(user, video))],
  ['discard', (user, video) => discard(event(user, video))],
  [
    'approve',
    (user, video) =>
      approve(
        event(user, video, {
          title: 'x',
          description: '',
          tags: [],
          pickVersion: 1,
          channelId: CHANNEL_A,
        }),
      ),
  ],
  [
    'recut',
    (user, _video, short) =>
      recut(event(user, short, { startSec: 10, lengthSec: 20, reframe: 'crop' })),
  ],
  ['make Short', (user, video) => makeShort(event(user, video))],
  [
    'confirm upload',
    (user, video) => confirmUpload(event(user, video, { url: 'https://youtu.be/dQw4w9WgXcQ' })),
  ],
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('one process, A → C → A', () => {
  it('serves each user only their own stats, Connections, jobs, media and Shorts', async () => {
    const turns = [
      [USER_A, 'a', 'b', CHANNEL_A, 'Flies Like Robots'],
      [USER_C, 'b', 'a', CHANNEL_C, ARTIST_C.name],
      [USER_A, 'a', 'b', CHANNEL_A, 'Flies Like Robots'],
    ] as const;
    const shorts: Record<string, string> = {};
    for (const [user, own, other, channel, title] of turns) {
      const layout = (await layoutLoad(event(user))) as Layout;
      expect(layout.channel?.handle).toBe(`@${channel}`);

      const connections = (await connectionsLoad(event(user))) as Connections;
      expect(connections.youtube?.channelTitle).toBe(title);

      const home = (await homeLoad(event(user))) as Home;
      expect(home.jobs.map((j) => j.id)).toEqual([own]);

      const page = (await jobLoad(event(user, own))) as JobPage;
      expect(page.view.job.id).toBe(own);
      expect(page.playbackUrl).toContain(`/uploads/${own}?`);
      expect(status(await Promise.resolve(jobLoad(event(user, other))).catch((e) => e))).toBe(404);

      const made = await makeShort(event(user, own));
      expect(made.status).toBe(200);
      const shortId = ((await made.json()) as { job: { id: string } }).job.id;
      // A's second turn gets A's own live Short back, never C's.
      shorts[own] ??= shortId;
      expect(shortId).toBe(shorts[own]);
      expect((await getJob(shortId))!.ownerUid).toBe(user.uid);

      // The API hands back only the caller's own media.
      const api = (await (await getJobApi(event(user, `${own}s`))).json()) as {
        playbackUrl?: string;
      };
      expect(api.playbackUrl).toContain(`/uploads/${own}s-1?`);

      const before = await Promise.all([getJob(other), getJob(`${other}s`)]);
      for (const [name, call] of FOREIGN_CALLS) {
        const outcome = await Promise.resolve(call(user, other, `${other}s`)).catch((e) => e);
        expect([name, status(outcome)]).toEqual([name, 404]);
      }
      expect(await Promise.all([getJob(other), getJob(`${other}s`)])).toEqual(before);
    }
    expect(shorts.a).not.toBe(shorts.b);
  });
});

describe("another user's browser upload", () => {
  const SESSION = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?upload_id=b-session';
  const FP = 'b'.repeat(64);

  beforeEach(async () => {
    h.createResumableUpload.mockReset();
    await seedJob({
      id: 'bu',
      ownerUid: USER_B.uid,
      artistId: null,
      state: 'AWAITING_UPLOAD',
      object: 'uploads/bu/o1',
      videoUpload: {
        sessionCipher: sealed(SESSION),
        generation: 1,
        size: 10,
        fingerprint: FP,
        ops: [],
      },
    });
  });

  it('404s every upload-session op and the page load before any session work', async () => {
    const decrypt = vi.spyOn(KeyManagementServiceClient.prototype, 'decrypt');
    const encrypt = vi.spyOn(KeyManagementServiceClient.prototype, 'encrypt');
    const before = await getJob('bu');
    const ops = [
      {
        op: 'pick',
        opId: 'op-1',
        generation: 1,
        size: 10,
        fingerprint: FP,
        filename: 'b.mp4',
        contentType: 'video/mp4',
        durationSec: 60,
      },
      { op: 'renew', opId: 'op-2', generation: 1, fingerprint: FP },
      { op: 'confirm', generation: 1, fingerprint: FP },
    ];
    for (const body of ops) {
      const outcome = await Promise.resolve(uploadSession(event(USER_A, 'bu', body))).catch(
        (e) => e,
      );
      expect([body.op, status(outcome)]).toEqual([body.op, 404]);
    }
    expect(status(await Promise.resolve(jobLoad(event(USER_A, 'bu'))).catch((e) => e))).toBe(404);
    expect(decrypt).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
    expect(h.createResumableUpload).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('upload_id'))).toBe(false);
    expect(await getJob('bu')).toEqual(before);
  });
});

describe('page loads start no research', () => {
  const loads: [string, (user: User) => unknown][] = [
    ['layout', (user) => layoutLoad(event(user))],
    ['home', (user) => homeLoad(event(user))],
    ['job', (user) => jobLoad(event(user, 'pk'))],
    ['connections', (user) => connectionsLoad(event(user))],
    ['settings', (user) => settingsLoad(event(user))],
    ['brand', (user) => brandLoad(event(user))],
  ];

  beforeEach(async () => {
    vi.stubEnv('RESEARCH_QUEUE', 'projects/p/locations/us-central1/queues/soundboard-research');
    vi.stubEnv('RESEARCH_TASK_URL', 'https://soundboard-1.us-central1.run.app/api/research/task');
    vi.stubEnv('RESEARCH_TASK_SA', 'research@p.iam.gserviceaccount.com');
    await seedJob({ id: 'pk', ...A_JOB, state: 'PICK', object: 'uploads/pk', probe: PROBE });
    fetchMock.mockClear();
  });

  it.each(loads)('the %s load inserts no run and calls no queue', async (_name, load) => {
    await load(USER_A);
    await load(USER_A);
    expect(await db().select().from(researchRuns)).toEqual([]);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('cloudtasks'))).toBe(
      false,
    );
  });

  it('leaves a PICK job at PICK with every load called in a row', async () => {
    for (const [, load] of loads) await load(USER_A);
    expect(await db().select().from(researchRuns)).toEqual([]);
    expect((await getJob('pk'))?.state).toBe('PICK');
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).host)).not.toContain(
      'cloudtasks.googleapis.com',
    );
  });
});

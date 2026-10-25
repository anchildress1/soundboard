// @vitest-environment node
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { load } from '#src/routes/jobs/[id]/+page.server.js';
import type { JobView } from '#lib/types.js';
import { seed, truncate } from '../../../../helpers/db';
import { gcs, land, resetGcs, seedSession, sessionFetch } from '../../../../helpers/gcs';
import { CHANNEL_A, sealed, seedJob, USER_A, USER_B, USERS } from '../../../../helpers/pipeline';
import { getJob, type JobDoc, type VideoUpload } from '#lib/server/jobs/jobs.js';

vi.mock('@google-cloud/kms', () => import('../../../../e2e/fakes/kms'));

const signed = vi.hoisted(() => ({ objects: [] as string[], missing: new Set<string>() }));

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      return {
        file: (object: string) => ({
          getSignedUrl: async ({ action }: { action: string }) => {
            signed.objects.push(object);
            return [`https://storage.googleapis.com/${name}/${object}?sig=${action}`];
          },
          exists: async () => [!signed.missing.has(object)],
          getMetadata: async () => [{ size: '10', contentType: 'video/mp4' }],
        }),
        getFiles: async () => [[]],
      };
    }
  },
}));

type Event = Parameters<typeof load>[0];
type Data = {
  expired: boolean;
  approveTo: { channelId: string; channelTitle: string | null } | null;
  view: JobView;
  short: JobView | null;
  shortExpired: boolean;
  playbackUrl: string | null;
  trace: { sentryTrace: string; baggage: string } | null;
  uploadSaved: { saved: number; total: number; done: boolean } | null;
  uploadGeneration: number;
};

const TRACE = { sentryTrace: 'abc-def-1', baggage: 'sentry-trace_id=abc' };

const localsFor = (user: typeof USER_A | typeof USER_B | null): Event['locals'] => ({ user });

async function run(id: string, user: typeof USER_A | typeof USER_B | null = USER_B) {
  const locals = localsFor(user);
  const data = (await load({ params: { id }, locals } as unknown as Event)) as Data;
  return { data, locals };
}

const fail = (id: string, locals: Event['locals']) =>
  Promise.resolve(load({ params: { id }, locals } as unknown as Event)).catch((e: unknown) => e);

const put = (id: string, patch: Partial<JobDoc> = {}) =>
  seedJob({ id, state: 'ANALYZE', object: `uploads/${id}`, trace: TRACE, ...patch });

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  vi.stubGlobal('fetch', sessionFetch);
  resetGcs();
  resetClients();
  signed.objects.length = 0;
  signed.missing.clear();
  await truncate();
  await seed(USERS);
});

describe('job page load', () => {
  it("hands the job's trace to the hooks and streams playback from GCS", async () => {
    await put('j');
    const { data, locals } = await run('j');
    expect(locals.jobTrace).toEqual(TRACE);
    expect(data.trace).toEqual(TRACE);
    expect(data.view.job.id).toBe('j');
    expect(data.view.job).not.toHaveProperty('trace');
    expect(data.playbackUrl).toBe('https://storage.googleapis.com/bkt/uploads/j?sig=read');
  });

  it('flags expired media and signs no playback for it, keeping the saved job', async () => {
    await put('j', { state: 'REVIEW', songTitle: 'PeekaBoo' });
    signed.missing.add('uploads/j');
    const { data } = await run('j');
    expect(data.expired).toBe(true);
    expect(data.playbackUrl).toBeNull();
    expect(data.view.job.songTitle).toBe('PeekaBoo');
    expect(signed.objects).toEqual([]);
  });

  it('does not flag media that is still in storage', async () => {
    await put('j', { state: 'REVIEW' });
    expect((await run('j')).data.expired).toBe(false);
  });

  it('skips playback while the browser upload is still running', async () => {
    await put('j', { state: 'AWAITING_UPLOAD', trace: null });
    const { data, locals } = await run('j');
    expect(data.playbackUrl).toBeNull();
    expect(locals.jobTrace).toBeNull();
  });

  it.each([
    ['another user', USER_A],
    ['a signed-out request', null],
  ])('404s the job for %s without touching locals or signing media', async (_label, user) => {
    await put('b');
    const locals = localsFor(user);
    const error = await fail('b', locals);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(locals.jobTrace).toBeUndefined();
    expect(signed.objects).toEqual([]);
  });
});

describe('job page load: where Approve uploads', () => {
  it("offers the owner's connected channel", async () => {
    await put('a', { ownerUid: USER_A.uid, state: 'REVIEW' });
    expect((await run('a', USER_A)).data.approveTo).toEqual({
      channelId: CHANNEL_A,
      channelTitle: 'Flies Like Robots',
    });
  });

  it('offers no channel to an owner without a connection', async () => {
    await put('b', { state: 'REVIEW' });
    expect((await run('b')).data.approveTo).toBeNull();
  });

  it('offers no channel while the connection is revoked', async () => {
    await seed({
      connections: [
        {
          uid: USER_B.uid,
          status: 'revoked',
          channelId: 'UCb',
          channelTitle: 'B',
          scopes: [],
          tokenCiphertext: null,
          updatedAt: new Date(0),
        },
      ],
    });
    await put('b', { state: 'REVIEW' });
    expect((await run('b')).data.approveTo).toBeNull();
  });
});

describe('job page load: Short', () => {
  const SHORT = {
    sourceDurationSec: 180,
    reframe: 'blur' as const,
    hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'x' },
    skipped: [],
    renders: 1,
    modelMs: 1,
  };

  it("loads the video's Short with its rendered playback", async () => {
    await put('j', { state: 'REVIEW', shortId: 's' });
    await put('s', { state: 'REVIEW', object: 'uploads/s-1', parentId: 'j', short: SHORT });
    const { data } = await run('j');
    expect(data.short?.job.id).toBe('s');
    expect(data.short?.playbackUrl).toBe('https://storage.googleapis.com/bkt/uploads/s-1?sig=read');
    expect(data.shortExpired).toBe(false);
  });

  it('flags a Short whose render storage dropped, signing no playback for it', async () => {
    await put('j', { state: 'REVIEW', shortId: 's' });
    await put('s', {
      state: 'REVIEW',
      object: 'uploads/s-1',
      sourceObject: 'uploads/j',
      parentId: 'j',
      short: SHORT,
    });
    signed.missing.add('uploads/s-1');
    const { data } = await run('j');
    expect(data.shortExpired).toBe(true);
    expect(data.short).not.toHaveProperty('playbackUrl');
    expect(data.expired).toBe(false);
  });

  it("flags a Short still cutting once its video's source is gone", async () => {
    await put('j', { state: 'REVIEW', shortId: 's' });
    await put('s', { state: 'HOOK', sourceObject: 'uploads/j', parentId: 'j', short: SHORT });
    signed.missing.add('uploads/j');
    expect((await run('j')).data.shortExpired).toBe(true);
  });

  it('shows no Short when there is none, or it is gone', async () => {
    await put('j', { state: 'REVIEW' });
    expect((await run('j')).data).toMatchObject({ short: null, shortExpired: false });
    await put('k', { state: 'REVIEW', shortId: 'vanished' });
    expect((await run('k')).data.short).toBeNull();
  });

  it('shows no Short once it was discarded', async () => {
    await put('j', { state: 'REVIEW', shortId: 's' });
    await put('s', { state: 'DISCARDED', parentId: 'j', short: SHORT });
    expect((await run('j')).data.short).toBeNull();
  });

  it("sends a Short's own URL to its video's page", async () => {
    await put('j', { state: 'REVIEW' });
    await put('s', { state: 'REVIEW', parentId: 'j', short: SHORT });
    const locals = localsFor(USER_B);
    const error = await fail('s', locals);
    expect(isRedirect(error) && [error.status, error.location]).toEqual([307, '/jobs/j']);
    expect(locals.jobTrace).toBeUndefined();
  });

  it("404s another user's Short instead of redirecting", async () => {
    await put('j', { state: 'REVIEW' });
    await put('s', { state: 'REVIEW', parentId: 'j', short: SHORT });
    const error = await fail('s', localsFor(USER_A));
    expect(isHttpError(error) && error.status).toBe(404);
  });
});

describe('job page load: the browser upload', () => {
  const SIZE = 4_000_000;
  let uri: string;
  const upload = (over: Partial<VideoUpload> = {}): VideoUpload => ({
    sessionCipher: sealed(uri),
    generation: 3,
    size: SIZE,
    fingerprint: 'a'.repeat(64),
    ops: [],
    ...over,
  });
  const uploading = (over: Partial<VideoUpload> = {}) =>
    put('u', { state: 'AWAITING_UPLOAD', object: 'uploads/u/a', videoUpload: upload(over) });

  beforeEach(() => {
    uri = seedSession('uploads/u/a', SIZE, 1_000_000);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the saved amount and the generation', async () => {
    await uploading();
    const { data } = await run('u');
    expect(data.uploadSaved).toEqual({ saved: 1_000_000, total: SIZE, done: false });
    expect(data.uploadGeneration).toBe(3);
  });

  it('reads 0 saved when GCS returns no Range', async () => {
    gcs.sessions.get(uri)!.saved = 0;
    await uploading();
    expect((await run('u')).data.uploadSaved).toEqual({ saved: 0, total: SIZE, done: false });
  });

  it('reads done once GCS has every byte', async () => {
    land(uri);
    await uploading();
    expect((await run('u')).data.uploadSaved).toEqual({ saved: SIZE, total: SIZE, done: true });
  });

  it('leaves the amount unknown when the query fails or never answers', async () => {
    await uploading();
    gcs.session.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await run('u')).data.uploadSaved).toBeNull();
    gcs.session.mockImplementationOnce(
      (_uri, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.timeout(10));
    expect((await run('u')).data.uploadSaved).toBeNull();
  });

  it('leaves it unknown with no session, and generation 0', async () => {
    await put('u', { state: 'AWAITING_UPLOAD' });
    const { data } = await run('u');
    expect(data.uploadSaved).toBeNull();
    expect(data.uploadGeneration).toBe(0);
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it('queries nothing for other states', async () => {
    await put('u', { state: 'REVIEW', videoUpload: upload() });
    expect((await run('u')).data.uploadSaved).toBeNull();
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it('finishes a discarded job’s owed upload cleanup', async () => {
    await put('u', { state: 'DISCARDED', object: 'uploads/u/a', videoUpload: upload() });
    await run('u');
    expect(gcs.sessions.get(uri)!.cancelled).toBe(true);
    expect((await getJob('u'))!.videoUpload).toBeNull();
  });

  it('never puts the session URI in the page data', async () => {
    await uploading();
    expect(JSON.stringify((await run('u')).data)).not.toContain('upload_id');
  });
});

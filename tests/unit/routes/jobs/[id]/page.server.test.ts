// @vitest-environment node
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/core/clients';
import type { JobDoc } from '$lib/server/jobs/jobs';
import { load } from '$routes/jobs/[id]/+page.server';
import type { JobView } from '$lib/types';
import { seed, truncate } from '../../../../helpers/db';
import { seedJob, USER_A, USER_B, USERS } from '../../../../helpers/pipeline';

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
      };
    }
  },
}));

type Event = Parameters<typeof load>[0];
type Data = {
  expired: boolean;
  view: JobView;
  short: JobView | null;
  playbackUrl: string | null;
  trace: { sentryTrace: string; baggage: string } | null;
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
  });

  it('shows no Short when there is none, or it is gone', async () => {
    await put('j', { state: 'REVIEW' });
    expect((await run('j')).data.short).toBeNull();
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

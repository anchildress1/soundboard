// @vitest-environment node
// Discard of a job awaiting its browser upload (research R10): the object read decides what is kept.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { ActionError } from '#lib/server/core/errors.js';
import { jobs } from '#lib/server/core/schema.js';
import { discard, finishDiscardCleanup } from '#lib/server/jobs/actions.js';
import { getJob, type JobDoc, type VideoUpload } from '#lib/server/jobs/jobs.js';
import { jobSet, type JobPatch } from '#lib/server/jobs/rows.js';
import { captureException } from '../../../../mocks/sentry';
import { seed, truncate } from '../../../../helpers/db';
import { gcs, land, resetGcs, seedSession, sessionFetch } from '../../../../helpers/gcs';
import { sealed, seedJob, USERS } from '../../../../helpers/pipeline';

vi.mock('@google-cloud/storage', () => import('../../../../helpers/gcs'));
vi.mock('@google-cloud/kms', () => import('../../../../e2e/fakes/kms'));

const SIZE = 1000;
const A = 'uploads/j1/a';
const B = 'uploads/j1/b';
const UNCHECKED = "Couldn't check the upload. Try again.";

let session: string;

const upload = (uri: string, generation = 2): VideoUpload => ({
  sessionCipher: sealed(uri),
  generation,
  size: SIZE,
  fingerprint: 'a'.repeat(64),
  ops: [],
});

const saved = async () => (await getJob('j1'))!;
const patch = (fields: JobPatch) => db().update(jobs).set(jobSet(fields)).where(eq(jobs.id, 'j1'));
const awaiting = (over: Partial<JobDoc> = {}) =>
  seedJob({ state: 'AWAITING_UPLOAD', object: A, videoUpload: upload(session), ...over });

const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ActionError);
  return error as ActionError;
};

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'bkt');
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  vi.stubGlobal('fetch', sessionFetch);
  resetClients();
  resetGcs();
  vi.mocked(captureException).mockClear();
  await truncate();
  await seed(USERS);
  session = seedSession(A, SIZE, 256);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('discard during the browser upload', () => {
  it('cancels an unfinished upload and deletes everything under its prefix', async () => {
    gcs.objects.set('uploads/j1/old', { size: 5, contentType: 'video/mp4' });
    gcs.objects.set('uploads/j1-1', { size: 5, contentType: 'video/mp4' });
    await discard(await awaiting());
    expect(gcs.sessions.get(session)!.cancelled).toBe(true);
    expect(gcs.deleted).toEqual(['uploads/j1/old']);
    expect(gcs.objects.has('uploads/j1-1')).toBe(true);
    expect(await saved()).toMatchObject({ state: 'DISCARDED', videoUpload: null });
  });

  it('keeps an upload that finished while the page was closed and sweeps only its orphans', async () => {
    land(session);
    gcs.objects.set('uploads/j1/old', { size: 5, contentType: 'video/mp4' });
    await discard(await awaiting());
    expect(gcs.objects.has(A)).toBe(true);
    expect(gcs.deleted).toEqual(['uploads/j1/old']);
    expect(gcs.sessions.get(session)!.cancelled).toBe(false);
    expect(await saved()).toMatchObject({ state: 'DISCARDED', videoUpload: null, object: A });
  });

  it('keeps a replacement that was picked and landed between the read and the update', async () => {
    const replacement = seedSession(B, SIZE);
    gcs.exists.mockImplementationOnce(async () => {
      // Another device picks file B and its last byte lands before discard's update.
      await patch({ object: B, videoUpload: upload(replacement, 3) });
      land(replacement);
      return false;
    });
    await discard(await awaiting());
    expect(gcs.objects.has(B)).toBe(true);
    expect(gcs.sessions.get(replacement)!.cancelled).toBe(false);
    expect(await saved()).toMatchObject({ state: 'DISCARDED', object: B, videoUpload: null });
  });

  it('cleans nothing up for a job that moved to PREP between the read and the update', async () => {
    gcs.exists.mockImplementationOnce(async () => {
      await patch({ state: 'PREP', videoUpload: null });
      return false;
    });
    await discard(await awaiting());
    expect(await saved()).toMatchObject({ state: 'DISCARDED' });
    expect(gcs.sessions.get(session)!.cancelled).toBe(false);
    expect(gcs.getFiles).not.toHaveBeenCalled();
  });

  it('answers 503 and changes nothing when the job keeps changing under it', async () => {
    let generation = 2;
    gcs.exists.mockImplementation(async () => {
      generation += 1;
      await patch({ videoUpload: upload(session, generation) });
      return false;
    });
    const error = await rejection(discard(await awaiting()));
    expect(error).toMatchObject({ status: 503, message: UNCHECKED });
    expect(gcs.exists).toHaveBeenCalledTimes(3);
    expect(await saved()).toMatchObject({ state: 'AWAITING_UPLOAD' });
    expect(gcs.sessions.get(session)!.cancelled).toBe(false);
  });

  it('answers 503 and changes nothing when the object read fails', async () => {
    gcs.exists.mockRejectedValueOnce(new Error('503 from GCS'));
    const error = await rejection(discard(await awaiting()));
    expect(error).toMatchObject({ status: 503, message: UNCHECKED });
    expect(await saved()).toMatchObject({ state: 'AWAITING_UPLOAD', videoUpload: upload(session) });
    expect(captureException).toHaveBeenCalled();
  });

  it('409s when the job left the discardable states meanwhile', async () => {
    gcs.exists.mockImplementationOnce(async () => {
      await patch({ state: 'VERIFIED' });
      return false;
    });
    const error = await rejection(discard(await awaiting()));
    expect(error.status).toBe(409);
  });

  it('discards a job without an upload session as before', async () => {
    await discard(await seedJob({ state: 'AWAITING_UPLOAD', object: 'uploads/j1' }));
    expect((await saved()).state).toBe('DISCARDED');
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it('leaves the cleanup owed when the cancel fails, and the next touch finishes it', async () => {
    gcs.session.mockResolvedValueOnce(new Response(null, { status: 500 }));
    gcs.session.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await discard(await awaiting());
    const owed = await saved();
    expect(owed).toMatchObject({ state: 'DISCARDED', videoUpload: upload(session) });
    // The session finished its last bytes before the cancel took: its object lands late.
    land(session);
    await finishDiscardCleanup(owed);
    expect(gcs.deleted).toContain(A);
    expect(gcs.sessions.get(session)!.cancelled).toBe(true);
    expect((await saved()).videoUpload).toBeNull();
  });

  it('leaves the cleanup owed when the sweep fails', async () => {
    gcs.objects.set('uploads/j1/old', { size: 5, contentType: 'video/mp4' });
    gcs.delete.mockRejectedValueOnce(new Error('403'));
    await discard(await awaiting());
    expect((await saved()).videoUpload).not.toBeNull();
  });
});

describe('finishDiscardCleanup', () => {
  it('does nothing for a job that is not discarded or has no upload', async () => {
    const job = await awaiting();
    await finishDiscardCleanup(job);
    await finishDiscardCleanup({ ...job, state: 'DISCARDED', videoUpload: null });
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it('stays owed and never throws when the session can’t be decrypted', async () => {
    const job = await awaiting({
      state: 'DISCARDED',
      videoUpload: { ...upload(session), sessionCipher: 'bm9wZQ==' },
    });
    await expect(finishDiscardCleanup(job)).resolves.toBeUndefined();
    expect((await saved()).videoUpload).not.toBeNull();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { action: 'discard-cleanup', 'job.id': 'j1' },
    });
  });
});

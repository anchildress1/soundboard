// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import { db } from '#lib/server/core/db.js';
import { ActionError } from '#lib/server/core/errors.js';
import { jobs } from '#lib/server/core/schema.js';
import { getJob, OPS_KEPT, type JobDoc, type VideoUpload } from '#lib/server/jobs/jobs.js';
import { jobSet, type JobPatch } from '#lib/server/jobs/rows.js';
import {
  DISCARDED,
  DONE,
  MOVED,
  REPLACED,
  savedAmount,
  Superseded,
  uploadSession,
} from '#lib/server/jobs/upload-session.js';
import { KeyManagementServiceClient } from '../../../../e2e/fakes/kms';
import { captureException } from '../../../../mocks/sentry';
import { seed, truncate } from '../../../../helpers/db';
import { deferred, gcs, land, resetGcs, seedSession, sessionFetch } from '../../../../helpers/gcs';
import { sealed, seedJob, USERS } from '../../../../helpers/pipeline';

vi.mock('@google-cloud/storage', () => import('../../../../helpers/gcs'));
vi.mock('@google-cloud/kms', () => import('../../../../e2e/fakes/kms'));

const ORIGIN = 'http://localhost:5173';
const SIZE = 50_000_000;
const A = 'uploads/j1/a';
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

let current: string;

const upload = (uri: string, over: Partial<VideoUpload> = {}): VideoUpload => ({
  sessionCipher: sealed(uri),
  generation: 2,
  size: SIZE,
  fingerprint: FP_A,
  ops: [],
  ...over,
});

const pickBody = (over: Record<string, unknown> = {}) => ({
  op: 'pick',
  opId: 'op-pick-a',
  generation: 2,
  size: SIZE,
  fingerprint: FP_A,
  filename: 'peekaboo.mp4',
  contentType: 'video/mp4',
  durationSec: 180,
  ...over,
});
const newFile = (over: Record<string, unknown> = {}) =>
  pickBody({
    fingerprint: FP_B,
    size: 40_000_000,
    filename: 'b.mov',
    contentType: 'video/quicktime',
    ...over,
  });
const renewBody = (over: Record<string, unknown> = {}) => ({
  op: 'renew',
  opId: 'op-renew-1',
  generation: 2,
  fingerprint: FP_A,
  ...over,
});
const confirmBody = (over: Record<string, unknown> = {}) => ({
  op: 'confirm',
  generation: 2,
  fingerprint: FP_A,
  ...over,
});

const saved = async () => (await getJob('j1'))!;
const patch = (fields: JobPatch) => db().update(jobs).set(jobSet(fields)).where(eq(jobs.id, 'j1'));
const send = async (body: Record<string, unknown>, job?: JobDoc) =>
  uploadSession(job ?? (await saved()), body, ORIGIN);
const cancels = (uri: string) =>
  sessionFetch.mock.calls.filter(([url, init]) => url === uri && init?.method === 'DELETE').length;

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
  current = seedSession(A, SIZE, 1_048_576);
  await seedJob({ state: 'AWAITING_UPLOAD', object: A, videoUpload: upload(current) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('pick', () => {
  it('resumes the same file: same session and object, generation bumped (a reload)', async () => {
    expect(await send(pickBody())).toEqual({
      sessionUri: current,
      generation: 3,
      restarted: false,
    });
    expect(await saved()).toMatchObject({
      object: A,
      videoUpload: {
        sessionCipher: sealed(current),
        generation: 3,
        ops: [{ opId: 'op-pick-a', generation: 3, restarted: false }],
      },
    });
    expect(gcs.createResumableUpload).not.toHaveBeenCalled();
    expect(cancels(current)).toBe(0);
  });

  it('starts a different file over on a new object and cancels only the displaced session', async () => {
    const reply = await send(newFile());
    expect(reply).toMatchObject({ generation: 3, restarted: true });
    const [created] = gcs.created;
    expect(created!.object).toMatch(/^uploads\/j1\/[\w-]{22}$/);
    expect(created!.options).toEqual({
      origin: ORIGIN,
      metadata: { contentType: 'video/quicktime', contentLength: 40_000_000 },
    });
    const job = await saved();
    expect(job).toMatchObject({
      object: created!.object,
      filename: 'b.mov',
      contentType: 'video/quicktime',
      videoUpload: { generation: 3, size: 40_000_000, fingerprint: FP_B },
    });
    expect(job.videoUpload!.sessionCipher).not.toContain('upload_id');
    expect(job.videoUpload!.sessionCipher).toBe(
      sealed((reply as { sessionUri: string }).sessionUri),
    );
    expect(cancels(current)).toBe(1);
    expect(cancels((reply as { sessionUri: string }).sessionUri)).toBe(0);
  });

  it('treats the same fingerprint at another size as a different file', async () => {
    expect(await send(pickBody({ size: SIZE - 1 }))).toMatchObject({ restarted: true });
  });

  it('starts a first session on a job that had none', async () => {
    await patch({ videoUpload: null });
    expect(await send(pickBody({ generation: 0 }))).toMatchObject({
      generation: 1,
      restarted: true,
    });
  });

  it.each([
    [{ contentType: 'audio/mpeg' }, 'Pick a video file.'],
    [{ size: 3 * 1024 ** 3 }, 'Videos must be under 2 GB.'],
    [{ durationSec: 16 * 60 }, 'Videos are capped at 15 minutes.'],
  ])('refuses a new file over the caps (%o) and changes nothing', async (over, message) => {
    const error = await rejection(send(newFile(over)));
    expect(error).toMatchObject({ status: 400, message });
    expect((await saved()).videoUpload).toEqual(upload(current));
    expect(gcs.createResumableUpload).not.toHaveBeenCalled();
  });

  it('409s a pick from a stale observed generation and changes nothing (a stale takeover)', async () => {
    const moved = await rejection(send(pickBody({ generation: 1 })));
    expect(moved).toBeInstanceOf(Superseded);
    expect(moved).toMatchObject({ status: 409, message: MOVED, generation: 2 });
    const replaced = await rejection(send(newFile({ generation: 1, opId: 'op-other' })));
    expect(replaced).toMatchObject({ message: REPLACED, generation: 2 });
    expect((await saved()).videoUpload).toEqual(upload(current));
    expect(gcs.createResumableUpload).not.toHaveBeenCalled();
  });

  it('lets another device take over the same file, and stops the old sender', async () => {
    // Device 2 loaded the page at generation 2 and picks the same file.
    expect(await send(pickBody({ opId: 'op-device-2' }))).toMatchObject({
      sessionUri: current,
      generation: 3,
    });
    const error = await rejection(send(confirmBody()));
    expect(error).toMatchObject({ status: 409, message: MOVED, generation: 3 });
  });

  it('settles two concurrent picks on one session; the loser 409s and its session is cancelled once', async () => {
    const job = await saved();
    const results = await Promise.allSettled([
      send(newFile({ opId: 'op-one' }), job),
      send(newFile({ opId: 'op-two', fingerprint: 'c'.repeat(64) }), job),
    ]);
    const won = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
      sessionUri: string;
    }>;
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409, generation: 3 });
    const sessions = [...gcs.sessions.keys()].filter((uri) => uri !== current);
    expect(sessions).toHaveLength(2);
    const loser = sessions.find((uri) => uri !== won.value.sessionUri)!;
    expect(cancels(loser)).toBe(1);
    expect(cancels(won.value.sessionUri)).toBe(0);
    expect(cancels(current)).toBe(1);
    expect((await saved()).videoUpload!.sessionCipher).toBe(sealed(won.value.sessionUri));
  });

  it('answers a retried pick from its ops while it is current, without bumping', async () => {
    const first = await send(pickBody());
    expect(await send(pickBody())).toEqual(first);
    expect((await saved()).videoUpload!.generation).toBe(3);
  });

  it('409s a lost pick reply retried after another device picked, and changes nothing', async () => {
    await send(pickBody({ opId: 'op-a' }));
    await send(newFile({ opId: 'op-b', generation: 3 }));
    const before = await saved();
    const error = await rejection(send(pickBody({ opId: 'op-a' })));
    expect(error).toMatchObject({ status: 409, message: REPLACED, generation: 4 });
    expect(await saved()).toEqual(before);
  });

  it('409s a pick retried after its opId was evicted from ops, and changes nothing', async () => {
    await send(pickBody({ opId: 'op-evicted' }));
    const later = Array.from({ length: OPS_KEPT }, (_, i) => ({
      opId: `op-later-${i}`,
      generation: 4 + i,
      restarted: false,
    }));
    await patch({ videoUpload: upload(current, { generation: 3 + OPS_KEPT, ops: later }) });
    const before = await saved();
    const error = await rejection(send(pickBody({ opId: 'op-evicted' })));
    expect(error).toMatchObject({ status: 409, message: MOVED, generation: 3 + OPS_KEPT });
    expect(await saved()).toEqual(before);
  });

  it('gives an overlapping retry of one opId the committed answer, not a 409', async () => {
    const reached = deferred();
    const held = deferred<string>();
    gcs.createResumableUpload.mockImplementationOnce(async (object) => {
      reached.resolve();
      const uri = await held.promise;
      gcs.sessions.set(uri, { object, size: 40_000_000, saved: 0, cancelled: false });
      return uri;
    });
    const job = await saved();
    // The first attempt outlives the client's 10 s timeout; the client retries with the same opId.
    const first = send(newFile({ opId: 'op-slow' }), job);
    await reached.promise;
    const retried = await send(newFile({ opId: 'op-slow' }), job);
    const slowUri =
      'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?uploadType=resumable&upload_id=slow';
    held.resolve(slowUri);
    expect(await first).toEqual(retried);
    expect(retried).toMatchObject({ generation: 3, restarted: true });
    expect(cancels(slowUri)).toBe(1);
    expect((await saved()).videoUpload!.generation).toBe(3);
  });
});

describe('renew', () => {
  it('opens a new object from the stored size and type, and cancels the old session', async () => {
    const reply = await send(renewBody());
    expect(reply).toMatchObject({ generation: 3, restarted: true });
    expect(gcs.created[0]!.options).toEqual({
      origin: ORIGIN,
      metadata: { contentType: 'video/mp4', contentLength: SIZE },
    });
    expect((await saved()).object).toBe(gcs.created[0]!.object);
    expect(cancels(current)).toBe(1);
  });

  it('answers a replayed renew as it did the first time', async () => {
    const first = await send(renewBody());
    expect(await send(renewBody())).toEqual(first);
    expect(gcs.created).toHaveLength(1);
  });

  it('409s a renew from a stale generation', async () => {
    await send(pickBody({ opId: 'op-elsewhere' }));
    expect(await rejection(send(renewBody()))).toMatchObject({ message: MOVED, generation: 3 });
    expect(await rejection(send(renewBody({ fingerprint: FP_B, opId: 'op-r2' })))).toMatchObject({
      message: REPLACED,
    });
    expect(gcs.created).toHaveLength(0);
  });
});

describe('confirm', () => {
  it('confirms the current generation and changes nothing', async () => {
    expect(await send(confirmBody())).toEqual({ current: true });
    expect((await saved()).videoUpload).toEqual(upload(current));
  });

  it('409s a stale generation: moved for the same file, replaced for another', async () => {
    await patch({ videoUpload: upload(current, { generation: 5 }) });
    expect(await rejection(send(confirmBody()))).toMatchObject({ message: MOVED, generation: 5 });
    expect(await rejection(send(confirmBody({ fingerprint: FP_B })))).toMatchObject({
      message: REPLACED,
    });
  });
});

describe('job checks', () => {
  it('409s once the current object landed', async () => {
    land(current);
    expect(await rejection(send(pickBody()))).toMatchObject({ status: 409, message: DONE });
    expect(await rejection(send(confirmBody()))).toMatchObject({ message: DONE });
  });

  it('409s once the job left AWAITING_UPLOAD', async () => {
    await patch({ state: 'PREP' });
    expect(await rejection(send(renewBody()))).toMatchObject({ status: 409, message: DONE });
  });

  it('409s a discarded job after finishing its owed cleanup', async () => {
    await patch({ state: 'DISCARDED' });
    expect(await rejection(send(pickBody()))).toMatchObject({ status: 409, message: DISCARDED });
    expect(cancels(current)).toBe(1);
    expect((await saved()).videoUpload).toBeNull();
  });

  it('answers discarded when a discard lands between the read and the commit', async () => {
    const job = await saved();
    gcs.createResumableUpload.mockImplementationOnce(async (object, options) => {
      await patch({ state: 'DISCARDED' });
      return seedSession(
        object,
        (options as { metadata: { contentLength: number } }).metadata.contentLength,
      );
    });
    expect(await rejection(send(newFile(), job))).toMatchObject({ message: DISCARDED });
    expect([...gcs.sessions.values()].every((s) => s.cancelled)).toBe(true);
  });

  it.each([
    [{ op: 'nope' }],
    [{ opId: '' }],
    [{ opId: 'bad id!' }],
    [{ fingerprint: 'ABC' }],
    [{ generation: undefined }],
    [{ generation: -1 }],
    [{ generation: 1.5 }],
  ])('400s a malformed pick %o', async (over) => {
    expect((await rejection(send(pickBody(over)))).status).toBe(400);
  });

  it.each([[{ generation: 0 }], [{ opId: undefined }]])(
    '400s a malformed renew %o',
    async (over) => {
      expect((await rejection(send(renewBody(over)))).status).toBe(400);
    },
  );

  it('400s a confirm without a generation', async () => {
    expect((await rejection(send(confirmBody({ generation: 0 })))).status).toBe(400);
  });
});

describe('boundaries', () => {
  /** A direct write to the row finishes while a boundary call is held: no transaction is open. */
  const writable = async () => {
    const write = db()
      .update(jobs)
      .set({ data: sql`${jobs.data} || '{"notes":"probe"}'::jsonb` })
      .where(eq(jobs.id, 'j1'));
    const timeout = new Promise((resolve) => setTimeout(() => resolve('blocked'), 1000));
    return await Promise.race([write.then(() => 'written'), timeout]);
  };

  it('holds no transaction while storage opens the session', async () => {
    const reached = deferred();
    const held = deferred();
    gcs.createResumableUpload.mockImplementationOnce(async (object, options) => {
      reached.resolve();
      await held.promise;
      return seedSession(
        object,
        (options as { metadata: { contentLength: number } }).metadata.contentLength,
      );
    });
    const picking = send(newFile());
    await reached.promise;
    expect(await writable()).toBe('written');
    held.resolve();
    await picking;
  });

  it('holds no transaction while KMS encrypts or decrypts', async () => {
    const reached = deferred();
    const held = deferred();
    const decrypt = KeyManagementServiceClient.prototype.decrypt;
    vi.spyOn(KeyManagementServiceClient.prototype, 'decrypt').mockImplementationOnce(
      async function (this: KeyManagementServiceClient, request) {
        reached.resolve();
        await held.promise;
        return decrypt.call(this, request);
      },
    );
    const picking = send(pickBody());
    await reached.promise;
    expect(await writable()).toBe('written');
    held.resolve();
    expect(await picking).toMatchObject({ sessionUri: current });
  });

  it('holds no transaction while the displaced session is cancelled', async () => {
    const reached = deferred();
    const held = deferred();
    gcs.session.mockImplementationOnce(async () => {
      reached.resolve();
      await held.promise;
      return new Response(null, { status: 499 });
    });
    const picking = send(newFile());
    await reached.promise;
    expect(await writable()).toBe('written');
    held.resolve();
    await picking;
  });

  it('rejects a session that never opens at its deadline and leaves the row unchanged', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    gcs.createResumableUpload.mockReturnValueOnce(new Promise(() => {}));
    const picking = send(newFile()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(((await picking) as Error).message).toBe(
      'Opening the upload session took longer than 10000 ms',
    );
    vi.useRealTimers();
    expect((await saved()).videoUpload).toEqual(upload(current));
  });

  it('never puts the session URI in an error or a Sentry call', async () => {
    const errors = await Promise.all([
      send(pickBody({ generation: 1 })).catch((e: Error) => e.message),
      send(confirmBody({ generation: 9 })).catch((e: Error) => e.message),
    ]);
    land(current);
    errors.push(await send(pickBody()).catch((e: Error) => e.message));
    for (const message of errors) expect(message).not.toContain('upload_id');
    expect(JSON.stringify(vi.mocked(captureException).mock.calls)).not.toContain('upload_id');
  });
});

describe('savedAmount', () => {
  it('reads what GCS saved', async () => {
    expect(await savedAmount(await saved())).toEqual({
      saved: 1_048_576,
      total: SIZE,
      done: false,
    });
  });

  it('reads 0 when nothing is saved yet', async () => {
    gcs.sessions.get(current)!.saved = 0;
    expect(await savedAmount(await saved())).toEqual({ saved: 0, total: SIZE, done: false });
  });

  it('reads done once GCS has every byte', async () => {
    land(current);
    expect(await savedAmount(await saved())).toEqual({ saved: SIZE, total: SIZE, done: true });
  });

  it('is null with no session, for other states, and when GCS or KMS fails', async () => {
    const job = await saved();
    expect(await savedAmount({ ...job, videoUpload: null })).toBeNull();
    expect(await savedAmount({ ...job, state: 'PREP' })).toBeNull();
    gcs.session.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await savedAmount(job)).toBeNull();
    expect(
      await savedAmount({ ...job, videoUpload: upload(current, { sessionCipher: 'bm9wZQ==' }) }),
    ).toBeNull();
    expect(sessionFetch).toHaveBeenCalledTimes(1);
  });
});

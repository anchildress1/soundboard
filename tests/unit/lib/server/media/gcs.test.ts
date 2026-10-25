// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '#lib/server/core/clients.js';
import {
  cancelUploadSession,
  createUploadSession,
  newUploadObject,
  objectInfo,
  signedReadUrl,
  sweepUploads,
  uploadFile,
  uploadOffset,
} from '#lib/server/media/gcs.js';

const UPLOAD_OBJECT = 'uploads/j1/o1';

const gcs = vi.hoisted(() => ({
  storageOptions: [] as unknown[],
  buckets: [] as string[],
  files: [] as string[],
  getSignedUrl: vi.fn(),
  exists: vi.fn(),
  getMetadata: vi.fn(),
  upload: vi.fn(),
  createResumableUpload: vi.fn(),
  getFiles: vi.fn(),
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    constructor(options: unknown) {
      gcs.storageOptions.push(options);
    }
    bucket(name: string) {
      gcs.buckets.push(name);
      return {
        upload: gcs.upload,
        getFiles: gcs.getFiles,
        file(object: string) {
          gcs.files.push(object);
          return {
            getSignedUrl: gcs.getSignedUrl,
            exists: gcs.exists,
            getMetadata: gcs.getMetadata,
            createResumableUpload: gcs.createResumableUpload,
          };
        },
      };
    }
  },
}));

const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'proj');
  vi.stubEnv('GCS_BUCKET', 'sb-media');
  resetClients();
  vi.clearAllMocks();
  gcs.storageOptions.length = 0;
  gcs.buckets.length = 0;
  gcs.files.length = 0;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

describe('uploadFile', () => {
  it('uploads the local file to the object with its content type', async () => {
    gcs.upload.mockResolvedValueOnce([{}]);
    await uploadFile('renders/short-s1-1.mp4', 'uploads/s1-1', 'video/mp4', 20_000);
    expect(gcs.buckets).toEqual(['sb-media']);
    // A single request, so the SDK applies the timeout; it ignores one on a resumable session.
    expect(gcs.upload).toHaveBeenCalledWith('renders/short-s1-1.mp4', {
      destination: 'uploads/s1-1',
      contentType: 'video/mp4',
      resumable: false,
      timeout: 20_000,
    });
  });

  it('propagates an upload failure', async () => {
    gcs.upload.mockRejectedValueOnce(new Error('403 Forbidden'));
    await expect(uploadFile('renders/x.mp4', 'uploads/x', 'video/mp4', 20_000)).rejects.toThrow(
      '403',
    );
  });
});

describe('signedReadUrl', () => {
  it('signs a v4 read for two hours', async () => {
    gcs.getSignedUrl.mockResolvedValueOnce(['https://storage/get']);
    expect(await signedReadUrl('uploads/a.mp4')).toBe('https://storage/get');
    expect(gcs.storageOptions).toEqual([{ projectId: 'proj' }]);
    expect(gcs.buckets).toEqual(['sb-media']);
    expect(gcs.files).toEqual(['uploads/a.mp4']);
    expect(gcs.getSignedUrl).toHaveBeenCalledWith({
      version: 'v4',
      action: 'read',
      expires: NOW + 2 * 60 * 60 * 1000,
    });
  });

  it('reuses the storage client across calls', async () => {
    gcs.getSignedUrl.mockResolvedValue(['u']);
    await signedReadUrl('a');
    await signedReadUrl('b');
    expect(gcs.storageOptions).toHaveLength(1);
  });

  it('throws without a bucket name', async () => {
    vi.stubEnv('GCS_BUCKET', '');
    await expect(signedReadUrl('a')).rejects.toThrow('GCS_BUCKET');
  });

  it('propagates a signing failure', async () => {
    gcs.getSignedUrl.mockRejectedValueOnce(new Error('no signer'));
    await expect(signedReadUrl('a')).rejects.toThrow('no signer');
  });
});

describe('objectInfo', () => {
  it('returns size and type for an uploaded object', async () => {
    gcs.exists.mockResolvedValueOnce([true]);
    gcs.getMetadata.mockResolvedValueOnce([{ size: '1048576', contentType: 'video/quicktime' }]);
    expect(await objectInfo(UPLOAD_OBJECT)).toEqual({
      size: 1048576,
      contentType: 'video/quicktime',
    });
  });

  it('returns null while the object is missing', async () => {
    gcs.exists.mockResolvedValueOnce([false]);
    expect(await objectInfo(UPLOAD_OBJECT)).toBeNull();
    expect(gcs.getMetadata).not.toHaveBeenCalled();
  });

  it('defaults missing metadata fields', async () => {
    gcs.exists.mockResolvedValueOnce([true]);
    gcs.getMetadata.mockResolvedValueOnce([{}]);
    expect(await objectInfo(UPLOAD_OBJECT)).toEqual({
      size: 0,
      contentType: 'application/octet-stream',
    });
  });
});

const SESSION =
  'https://storage.googleapis.com/upload/storage/v1/b/sb-media/o?uploadType=resumable&upload_id=secret-id';
const SIZE = 1_000_000;

const fetchMock = vi.fn<typeof fetch>();
const reply = (status: number, headers?: Record<string, string>) =>
  new Response(null, { status, headers });

describe('upload sessions', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('newUploadObject', () => {
    it('names a random object under the job prefix', () => {
      const name = newUploadObject('job1');
      expect(name).toMatch(/^uploads\/job1\/[A-Za-z0-9_-]{22}$/);
    });

    it('never repeats a name', () => {
      const names = new Set(Array.from({ length: 50 }, () => newUploadObject('job1')));
      expect(names.size).toBe(50);
    });
  });

  describe('createUploadSession', () => {
    it('opens a JSON API session with the origin, type and declared size, and no precondition', async () => {
      gcs.createResumableUpload.mockResolvedValueOnce([SESSION]);
      const uri = await createUploadSession('uploads/job1/abc', {
        origin: 'http://localhost:5173',
        contentType: 'video/mp4',
        size: SIZE,
      });
      expect(uri).toBe(SESSION);
      expect(gcs.files).toEqual(['uploads/job1/abc']);
      expect(gcs.createResumableUpload).toHaveBeenCalledWith({
        origin: 'http://localhost:5173',
        metadata: { contentType: 'video/mp4', contentLength: SIZE },
      });
    });

    it('rejects a session that never opens at 10 s', async () => {
      vi.useFakeTimers();
      gcs.createResumableUpload.mockReturnValueOnce(new Promise(() => {}));
      const opening = createUploadSession('o', {
        origin: 'o',
        contentType: 'video/mp4',
        size: 1,
      }).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(((await opening) as Error).message).toBe(
        'Opening the upload session took longer than 10000 ms',
      );
    });
  });

  describe('uploadOffset', () => {
    it('sends the documented status query', async () => {
      fetchMock.mockResolvedValueOnce(reply(308));
      await uploadOffset(SESSION, SIZE);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(SESSION);
      expect(init).toMatchObject({
        method: 'PUT',
        headers: { 'content-range': `bytes */${SIZE}` },
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([200, 201])('reads %i as done', async (status) => {
      fetchMock.mockResolvedValueOnce(reply(status));
      expect(await uploadOffset(SESSION, SIZE)).toEqual({ done: true });
    });

    it('resumes after the last saved byte', async () => {
      fetchMock.mockResolvedValueOnce(reply(308, { range: 'bytes=0-262143' }));
      expect(await uploadOffset(SESSION, SIZE)).toEqual({ done: false, saved: 262_144 });
    });

    it('starts from 0 when nothing is saved', async () => {
      fetchMock.mockResolvedValueOnce(reply(308));
      expect(await uploadOffset(SESSION, SIZE)).toEqual({ done: false, saved: 0 });
    });

    it('starts from 0 on a Range it can’t read', async () => {
      fetchMock.mockResolvedValueOnce(reply(308, { range: 'bytes=5-9' }));
      expect(await uploadOffset(SESSION, SIZE)).toEqual({ done: false, saved: 0 });
    });

    it('throws on any other answer, without the session URI', async () => {
      fetchMock.mockResolvedValueOnce(reply(404));
      const error = (await uploadOffset(SESSION, SIZE).catch((e: Error) => e)) as Error;
      expect(error.message).toBe('The upload status query answered 404.');
      expect(error.message).not.toContain('secret-id');
    });

    it('throws a clean error when the network fails', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed ${SESSION}`));
      const error = (await uploadOffset(SESSION, SIZE).catch((e: Error) => e)) as Error;
      expect(error.message).toBe('The upload status query failed.');
      expect(error.cause).toBeUndefined();
    });

    it('caps its timeout at what the step deadline leaves', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      fetchMock.mockResolvedValueOnce(reply(308));
      await uploadOffset(SESSION, SIZE, NOW + 1200);
      expect(timeout).toHaveBeenCalledWith(1200);
      fetchMock.mockResolvedValueOnce(reply(308));
      await uploadOffset(SESSION, SIZE);
      expect(timeout).toHaveBeenLastCalledWith(5000);
    });

    it('fails a query that never answers at its deadline', async () => {
      fetchMock.mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
          ),
      );
      const query = uploadOffset(SESSION, SIZE, Date.now() + 20);
      await expect(query).rejects.toThrow('The upload status query failed.');
    });
  });

  describe('cancelUploadSession', () => {
    it.each([200, 204, 404, 410, 499])('counts %i as cancelled', async (status) => {
      fetchMock.mockResolvedValueOnce(reply(status));
      expect(await cancelUploadSession(SESSION)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' });
    });

    it('retries once', async () => {
      fetchMock.mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(499));
      expect(await cancelUploadSession(SESSION)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up after two failures and never throws', async () => {
      fetchMock.mockResolvedValueOnce(reply(500)).mockRejectedValueOnce(new TypeError('down'));
      expect(await cancelUploadSession(SESSION)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('sweepUploads', () => {
    const file = (name: string, remove = vi.fn(async () => [{}])) => ({ name, delete: remove });

    it('deletes every object under the job prefix but the one kept', async () => {
      const kept = file('uploads/job1/keep');
      const orphan = file('uploads/job1/old');
      gcs.getFiles.mockResolvedValueOnce([[kept, orphan]]);
      expect(await sweepUploads('job1', 'uploads/job1/keep')).toBe(true);
      expect(gcs.getFiles).toHaveBeenCalledWith({ prefix: 'uploads/job1/' });
      expect(orphan.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
      expect(kept.delete).not.toHaveBeenCalled();
    });

    it('lists with a trailing slash, so a Short render is never matched', async () => {
      gcs.getFiles.mockResolvedValueOnce([[]]);
      await sweepUploads('job1', null);
      expect(gcs.getFiles.mock.calls[0]![0].prefix).toBe('uploads/job1/');
      expect('uploads/job1-1'.startsWith(gcs.getFiles.mock.calls[0]![0].prefix)).toBe(false);
    });

    it('deletes everything when nothing is kept', async () => {
      const a = file('uploads/job1/a');
      const b = file('uploads/job1/b');
      gcs.getFiles.mockResolvedValueOnce([[a, b]]);
      expect(await sweepUploads('job1', null)).toBe(true);
      expect(a.delete).toHaveBeenCalled();
      expect(b.delete).toHaveBeenCalled();
    });

    it('reports a failed delete', async () => {
      const failing = file(
        'uploads/job1/a',
        vi.fn(async () => {
          throw new Error('403');
        }),
      );
      gcs.getFiles.mockResolvedValueOnce([[failing, file('uploads/job1/b')]]);
      expect(await sweepUploads('job1', null)).toBe(false);
    });

    it('reports a listing that fails or never answers', async () => {
      gcs.getFiles.mockRejectedValueOnce(new Error('503'));
      expect(await sweepUploads('job1', null)).toBe(false);
      vi.useFakeTimers();
      gcs.getFiles.mockReturnValueOnce(new Promise(() => {}));
      const sweeping = sweepUploads('job1', null);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await sweeping).toBe(false);
    });
  });

  describe('objectInfo deadline', () => {
    it('rejects a stalled read at 5 s', async () => {
      vi.useFakeTimers();
      gcs.exists.mockReturnValueOnce(new Promise(() => {}));
      const reading = objectInfo(UPLOAD_OBJECT).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(5000);
      expect(((await reading) as Error).message).toBe(
        'Reading the upload object took longer than 5000 ms',
      );
    });

    it('rejects at the step deadline when that comes first', async () => {
      vi.useFakeTimers({ now: NOW });
      gcs.exists.mockReturnValueOnce(new Promise(() => {}));
      const reading = objectInfo(UPLOAD_OBJECT, NOW + 1000).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(1000);
      expect(((await reading) as Error).message).toContain('1000 ms');
    });
  });
});

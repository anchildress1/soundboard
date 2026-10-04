// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClients } from '$lib/server/clients';
import {
  objectInfo,
  signedReadUrl,
  signedUploadUrl,
  uploadFile,
  uploadObjectName,
} from '$lib/server/gcs';

const UPLOAD_OBJECT = 'uploads/j1';

const gcs = vi.hoisted(() => ({
  storageOptions: [] as unknown[],
  buckets: [] as string[],
  files: [] as string[],
  getSignedUrl: vi.fn(),
  exists: vi.fn(),
  getMetadata: vi.fn(),
  upload: vi.fn(),
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
        file(object: string) {
          gcs.files.push(object);
          return {
            getSignedUrl: gcs.getSignedUrl,
            exists: gcs.exists,
            getMetadata: gcs.getMetadata,
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

describe('uploadObjectName', () => {
  it('puts uploads under uploads/', () => {
    expect(uploadObjectName('abc')).toBe('uploads/abc');
  });
});

describe('signedUploadUrl', () => {
  it('signs a v4 write with the content type and the 2 GB range header', async () => {
    gcs.getSignedUrl.mockResolvedValueOnce(['https://storage/put']);
    expect(await signedUploadUrl(UPLOAD_OBJECT, 'video/mp4')).toBe('https://storage/put');
    expect(gcs.storageOptions).toEqual([{ projectId: 'proj' }]);
    expect(gcs.buckets).toEqual(['sb-media']);
    expect(gcs.files).toEqual([UPLOAD_OBJECT]);
    expect(gcs.getSignedUrl).toHaveBeenCalledWith({
      version: 'v4',
      action: 'write',
      expires: NOW + 30 * 60 * 1000,
      contentType: 'video/mp4',
      extensionHeaders: { 'x-goog-content-length-range': '1,2147483648' },
    });
  });

  it('reuses the storage client across calls', async () => {
    gcs.getSignedUrl.mockResolvedValue(['u']);
    await signedUploadUrl('a', 'video/mp4');
    await signedUploadUrl('b', 'video/webm');
    expect(gcs.storageOptions).toHaveLength(1);
  });

  it('throws without a bucket name', async () => {
    vi.stubEnv('GCS_BUCKET', '');
    await expect(signedUploadUrl('a', 'video/mp4')).rejects.toThrow('GCS_BUCKET');
  });

  it('propagates a signing failure', async () => {
    gcs.getSignedUrl.mockRejectedValueOnce(new Error('no signer'));
    await expect(signedUploadUrl('a', 'video/mp4')).rejects.toThrow('no signer');
  });
});

describe('uploadFile', () => {
  it('uploads the local file to the object with its content type', async () => {
    gcs.upload.mockResolvedValueOnce([{}]);
    await uploadFile('renders/short-s1-1.mp4', 'uploads/s1-1', 'video/mp4');
    expect(gcs.buckets).toEqual(['sb-media']);
    expect(gcs.upload).toHaveBeenCalledWith('renders/short-s1-1.mp4', {
      destination: 'uploads/s1-1',
      contentType: 'video/mp4',
    });
  });

  it('propagates an upload failure', async () => {
    gcs.upload.mockRejectedValueOnce(new Error('403 Forbidden'));
    await expect(uploadFile('renders/x.mp4', 'uploads/x', 'video/mp4')).rejects.toThrow('403');
  });
});

describe('signedReadUrl', () => {
  it('signs a v4 read for two hours', async () => {
    gcs.getSignedUrl.mockResolvedValueOnce(['https://storage/get']);
    expect(await signedReadUrl('samples/a.mp4')).toBe('https://storage/get');
    expect(gcs.files).toEqual(['samples/a.mp4']);
    expect(gcs.getSignedUrl).toHaveBeenCalledWith({
      version: 'v4',
      action: 'read',
      expires: NOW + 2 * 60 * 60 * 1000,
    });
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

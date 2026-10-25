import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  action,
  ApiError,
  approveBrand,
  createJob,
  discardBrandProposal,
  proposeBrand,
  SessionTimeout,
  step,
  UploadConflict,
  uploadSession,
  uploadToGcs,
} from '#lib/api.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastInit = () =>
  fetchMock.mock.calls.at(-1)![1] as RequestInit & { headers: Record<string, string> };

const BODY = {
  songTitle: 'PeekaBoo',
  notes: '',
  filename: 'a.mp4',
  contentType: 'video/mp4',
  size: 10,
  durationSec: 60,
};

describe('createJob', () => {
  it('POSTs JSON and returns the body', async () => {
    fetchMock.mockResolvedValue(json(200, { id: 'j1', uploadUrl: 'https://u' }));
    const body = BODY;
    expect(await createJob(body)).toEqual({ id: 'j1', uploadUrl: 'https://u' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/jobs');
    expect(lastInit().method).toBe('POST');
    expect(lastInit().headers['content-type']).toBe('application/json');
    expect(JSON.parse(lastInit().body as string)).toEqual(body);
  });

  it('throws ApiError with the server error and field errors', async () => {
    fetchMock.mockResolvedValue(
      json(422, { error: 'Invalid fields', fields: { title: 'Title is required.' } }),
    );
    const err = await createJob(BODY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 422,
      message: 'Invalid fields',
      fields: { title: 'Title is required.' },
    });
  });

  it('falls back to message, then a generic text, when the body has no error', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { message: 'Bad request' }));
    await expect(createJob(BODY)).rejects.toMatchObject({
      message: 'Bad request',
      fields: null,
    });
    fetchMock.mockResolvedValueOnce(new Response('<html>oops</html>', { status: 502 }));
    await expect(createJob(BODY)).rejects.toMatchObject({
      status: 502,
      message: 'Request failed (502)',
    });
  });

  it('returns an empty object for an OK response without JSON', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await createJob(BODY)).toEqual({});
  });

  it('propagates network failures', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createJob(BODY)).rejects.toThrow('Failed to fetch');
  });
});

describe('step', () => {
  it('sends trace headers when the job has a trace', async () => {
    fetchMock.mockResolvedValue(json(200, { job: { id: 'j1' } }));
    await step('j1', { sentryTrace: 'abc-def-1', baggage: 'sentry-env=prod' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/jobs/j1/step');
    expect(lastInit().method).toBe('POST');
    expect(lastInit().headers).toEqual({
      'content-type': 'application/json',
      'sentry-trace': 'abc-def-1',
      baggage: 'sentry-env=prod',
    });
  });

  it('sends no trace headers without a trace', async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    await step('j1', null);
    expect(lastInit().headers).toEqual({ 'content-type': 'application/json' });
  });

  it('throws ApiError on 404', async () => {
    fetchMock.mockResolvedValue(json(404, { message: 'Not Found' }));
    await expect(step('gone', null)).rejects.toMatchObject({ status: 404, message: 'Not Found' });
  });
});

describe('action', () => {
  it('POSTs the named action with a JSON body', async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    await action('j1', 'approve', null, { title: 'T' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/jobs/j1/approve');
    expect(JSON.parse(lastInit().body as string)).toEqual({ title: 'T' });
  });

  it('keeps a 409 from another route a plain ApiError', async () => {
    fetchMock.mockResolvedValue(json(409, { message: 'Busy' }));
    const err = await action('j1', 'approve', null).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UploadConflict);
    expect(err).toMatchObject({ status: 409, message: 'Busy' });
  });

  it('defaults to an empty body and carries trace headers', async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    await action('j1', 'discard', { sentryTrace: 't', baggage: '' });
    expect(lastInit().body).toBe('{}');
    expect(lastInit().headers['sentry-trace']).toBe('t');
  });
});

describe('brand guide', () => {
  it('POSTs propose, approve with the guide, and discard to their routes', async () => {
    fetchMock.mockImplementation(async () => json(200, {}));
    const guide = { statement: 's', keep: ['k'], fix: [], drop: [] };
    await proposeBrand();
    await approveBrand(guide, 42);
    await discardBrandProposal();
    expect(fetchMock.mock.calls.map((c) => [c[0], (c[1] as RequestInit).method])).toEqual([
      ['/api/brand/propose', 'POST'],
      ['/api/brand/approve', 'POST'],
      ['/api/brand/discard', 'POST'],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toEqual({
      ...guide,
      proposedAt: 42,
    });
  });
});

describe('uploadSession', () => {
  const FP = 'a'.repeat(64);
  const PICK = {
    op: 'pick',
    opId: 'op-1',
    generation: 0,
    size: 10,
    fingerprint: FP,
    filename: 'a.mp4',
    contentType: 'video/mp4',
    durationSec: 60,
  } as const;
  const RENEW = { op: 'renew', opId: 'op-2', generation: 3, fingerprint: FP } as const;
  const CONFIRM = { op: 'confirm', generation: 3, fingerprint: FP } as const;
  const session = { sessionUri: 'https://storage/s', generation: 4, restarted: true };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['pick', PICK, session],
    ['renew', RENEW, session],
    ['confirm', CONFIRM, { current: true }],
  ])('POSTs a %s as JSON and returns the reply', async (_op, body, reply) => {
    fetchMock.mockResolvedValue(json(200, reply));
    expect(await uploadSession('j1', body)).toEqual(reply);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/jobs/j1/upload-session');
    expect(lastInit().method).toBe('POST');
    expect(JSON.parse(lastInit().body as string)).toEqual(body);
    expect(lastInit().signal).toBeInstanceOf(AbortSignal);
  });

  it('throws UploadConflict with the message and the current generation on a 409', async () => {
    fetchMock.mockResolvedValue(
      json(409, { error: 'The upload moved to another device or window.', generation: 7 }),
    );
    const err = await uploadSession('j1', PICK).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadConflict);
    expect(err).toMatchObject({
      status: 409,
      message: 'The upload moved to another device or window.',
      generation: 7,
    });
  });

  it('leaves the generation null on a 409 that names none', async () => {
    fetchMock.mockResolvedValue(json(409, { message: 'This job was discarded.' }));
    await expect(uploadSession('j1', CONFIRM)).rejects.toMatchObject({
      message: 'This job was discarded.',
      generation: null,
    });
  });

  it('throws a plain ApiError on a 404', async () => {
    fetchMock.mockResolvedValue(json(404, { message: 'Not Found' }));
    const err = await uploadSession('j1', RENEW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(UploadConflict);
    expect(err).toMatchObject({ status: 404 });
  });

  it('rejects with SessionTimeout when the server never answers within 10 s', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    fetchMock.mockImplementation(
      (_path: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const pending = uploadSession('j1', CONFIRM);
    expect(timeout).toHaveBeenCalledWith(10_000);
    controller.abort(new DOMException('signal timed out', 'TimeoutError'));
    await expect(pending).rejects.toBeInstanceOf(SessionTimeout);
  });

  it('passes other network failures through', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(uploadSession('j1', CONFIRM)).rejects.toThrow('Failed to fetch');
  });
});

describe('uploadToGcs', () => {
  let lastXhr: FakeXhr;
  const track = (xhr: FakeXhr) => {
    lastXhr = xhr;
  };
  class FakeXhr {
    upload: {
      onprogress:
        ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
    } = {
      onprogress: null,
    };
    status = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open = vi.fn();
    setRequestHeader = vi.fn();
    send = vi.fn();
    constructor() {
      track(this);
    }
  }

  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });

  const file = new File(['abc'], 'a.mp4', { type: 'video/mp4' });

  it('PUTs the file with the signed headers and reports progress', async () => {
    const progress = vi.fn();
    const done = uploadToGcs('https://storage.example/u?sig=1', file, 'video/mp4', progress);
    const xhr = lastXhr;
    expect(xhr.open).toHaveBeenCalledWith('PUT', 'https://storage.example/u?sig=1');
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('content-type', 'video/mp4');
    expect(xhr.setRequestHeader).toHaveBeenCalledWith(
      'x-goog-content-length-range',
      '1,2147483648',
    );
    expect(xhr.send).toHaveBeenCalledWith(file);
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 1, total: 3 });
    xhr.upload.onprogress!({ lengthComputable: false, loaded: 2, total: 0 });
    expect(progress.mock.calls).toEqual([[33]]);
    xhr.status = 200;
    xhr.onload!();
    await expect(done).resolves.toBeUndefined();
  });

  it('sends the signed content type, not the browser-reported one', async () => {
    const untyped = new File(['abc'], 'clip.mkv');
    void uploadToGcs('u', untyped, 'video/mp4', () => {});
    expect(lastXhr.setRequestHeader).toHaveBeenCalledWith('content-type', 'video/mp4');
  });

  it('rejects with the HTTP status on a failed upload', async () => {
    const done = uploadToGcs('u', file, 'video/mp4', () => {});
    lastXhr.status = 403;
    lastXhr.onload!();
    await expect(done).rejects.toMatchObject({ status: 403, message: 'Upload failed (403)' });
  });

  it('treats 299 as success and 300 as failure', async () => {
    const ok = uploadToGcs('u', file, 'video/mp4', () => {});
    lastXhr.status = 299;
    lastXhr.onload!();
    await expect(ok).resolves.toBeUndefined();
    const redirect = uploadToGcs('u', file, 'video/mp4', () => {});
    lastXhr.status = 300;
    lastXhr.onload!();
    await expect(redirect).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects with status 0 on a network error', async () => {
    const done = uploadToGcs('u', file, 'video/mp4', () => {});
    lastXhr.onerror!();
    await expect(done).rejects.toMatchObject({
      status: 0,
      message: 'Upload failed: network error',
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { action, ApiError, createJob, step, uploadToGcs } from '$lib/api';

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

describe('createJob', () => {
  it('POSTs JSON and returns the body', async () => {
    fetchMock.mockResolvedValue(json(200, { id: 'j1', uploadUrl: 'https://u' }));
    const body = {
      songTitle: 'PeekaBoo',
      notes: '',
      filename: 'a.mp4',
      contentType: 'video/mp4',
      size: 10,
      durationSec: 60,
    };
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
    const err = await createJob({ sampleId: 's1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 422,
      message: 'Invalid fields',
      fields: { title: 'Title is required.' },
    });
  });

  it('falls back to message, then a generic text, when the body has no error', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { message: 'Bad sample' }));
    await expect(createJob({ sampleId: 's' })).rejects.toMatchObject({
      message: 'Bad sample',
      fields: null,
    });
    fetchMock.mockResolvedValueOnce(new Response('<html>oops</html>', { status: 502 }));
    await expect(createJob({ sampleId: 's' })).rejects.toMatchObject({
      status: 502,
      message: 'Request failed (502)',
    });
  });

  it('returns an empty object for an OK response without JSON', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await createJob({ sampleId: 's' })).toEqual({});
  });

  it('propagates network failures', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createJob({ sampleId: 's' })).rejects.toThrow('Failed to fetch');
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

  it('defaults to an empty body and carries trace headers', async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    await action('j1', 'discard', { sentryTrace: 't', baggage: '' });
    expect(lastInit().body).toBe('{}');
    expect(lastInit().headers['sentry-trace']).toBe('t');
  });
});

describe('uploadToGcs', () => {
  class FakeXhr {
    static last: FakeXhr;
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
      FakeXhr.last = this;
    }
  }

  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });

  const file = new File(['abc'], 'a.mp4', { type: 'video/mp4' });

  it('PUTs the file with the signed headers and reports progress', async () => {
    const progress = vi.fn();
    const done = uploadToGcs('https://storage.example/u?sig=1', file, progress);
    const xhr = FakeXhr.last;
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

  it('rejects with the HTTP status on a failed upload', async () => {
    const done = uploadToGcs('u', file, () => {});
    FakeXhr.last.status = 403;
    FakeXhr.last.onload!();
    await expect(done).rejects.toMatchObject({ status: 403, message: 'Upload failed (403)' });
  });

  it('treats 299 as success and 300 as failure', async () => {
    const ok = uploadToGcs('u', file, () => {});
    FakeXhr.last.status = 299;
    FakeXhr.last.onload!();
    await expect(ok).resolves.toBeUndefined();
    const redirect = uploadToGcs('u', file, () => {});
    FakeXhr.last.status = 300;
    FakeXhr.last.onload!();
    await expect(redirect).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects with status 0 on a network error', async () => {
    const done = uploadToGcs('u', file, () => {});
    FakeXhr.last.onerror!();
    await expect(done).rejects.toMatchObject({
      status: 0,
      message: 'Upload failed: network error',
    });
  });
});

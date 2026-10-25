import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLocks, FakeXhr } from '../../helpers/uploads';

type UploadModule = typeof import('#lib/upload.js');
type SentryMock = typeof import('../../mocks/sentry');

const JOB = 'job-1';
const SIZE = 1000;
const FP = 'f'.repeat(64);
const URI = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?upload_id=s1';
const URI_2 = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?upload_id=s2';

type AppBody = { op: string; opId?: string; generation: number; fingerprint: string };
type AppCall = { path: string; body: AppBody | null };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let calls: AppCall[];
let answer: (call: AppCall) => Response | Promise<Response>;
let locks: FakeLocks;

const defaultAnswer = ({ body }: AppCall): Response => {
  if (body!.op === 'renew') {
    return json(200, { sessionUri: URI_2, generation: body!.generation + 1, restarted: true });
  }
  return json(200, { current: true });
};

const flush = () => vi.advanceTimersByTimeAsync(0);
const xhrs = () => FakeXhr.all;
const last = () => FakeXhr.all.at(-1)!;
const ops = () => calls.filter((call) => call.body).map((call) => call.body!.op);
const file = (size = SIZE) => new File([new Uint8Array(size)], 'peekaboo.mp4');

let tabs: UploadModule[] = [];

/** A fresh tab: the module's store, runs and locks start empty. */
async function tab(): Promise<UploadModule & { sentry: SentryMock }> {
  vi.resetModules();
  const upload = await import('#lib/upload.js');
  tabs.push(upload);
  const sentry = (await import('@sentry/sveltekit')) as unknown as SentryMock;
  return { ...upload, sentry };
}

const entryOf = (upload: UploadModule) => {
  let value: Record<string, import('#lib/upload.js').Upload> = {};
  upload.uploads.subscribe((all) => (value = all))();
  return value[JOB];
};

async function started(upload: UploadModule, size = SIZE, generation = 1) {
  expect(await upload.acquire(JOB)).toBe(true);
  upload.start(JOB, { file: file(size), sessionUri: URI, generation, fingerprint: FP });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeXhr.all = [];
  FakeXhr.handler = null;
  calls = [];
  answer = defaultAnswer;
  locks = new FakeLocks();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
  // Node's AbortSignal.timeout runs on real timers; route it through the faked ones.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init: RequestInit) => {
      const call = { path, body: init.body ? (JSON.parse(init.body as string) as AppBody) : null };
      calls.push(call);
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        Promise.resolve(answer(call)).then(resolve, reject);
      });
    }),
  );
});

afterEach(() => {
  // Each tab's window listeners outlive the test; a stopped tab has nothing for them to wake.
  for (const upload of tabs) upload.stop(JOB);
  tabs = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('nextAction', () => {
  it.each([
    [{ status: 200, range: null }, { do: 'done' }],
    [{ status: 201, range: null }, { do: 'done' }],
    [
      { status: 308, range: null },
      { do: 'send', offset: 0 },
    ],
    [
      { status: 308, range: 'bytes=0-511' },
      { do: 'send', offset: 512 },
    ],
    [
      { status: 308, range: 'bytes=0-999' },
      { do: 'pause', reason: '5xx' },
    ],
    [
      { status: 308, range: 'bytes=10-20' },
      { do: 'pause', reason: '5xx' },
    ],
    [
      { status: 0, range: null },
      { do: 'pause', reason: 'offline' },
    ],
    [
      { status: 408, range: null },
      { do: 'pause', reason: '408' },
    ],
    [
      { status: 429, range: null },
      { do: 'pause', reason: '429' },
    ],
    [
      { status: 500, range: null },
      { do: 'pause', reason: '5xx' },
    ],
    [
      { status: 503, range: null },
      { do: 'pause', reason: '5xx' },
    ],
    [
      { status: 302, range: null },
      { do: 'pause', reason: '5xx' },
    ],
    [{ status: 404, range: null }, { do: 'renew' }],
    [{ status: 410, range: null }, { do: 'renew' }],
    [{ status: 499, range: null }, { do: 'renew' }],
    [
      { status: 400, range: null },
      { do: 'fail', message: 'Upload failed (400)' },
    ],
    [
      { status: 403, range: null },
      { do: 'fail', message: 'Upload failed (403)' },
    ],
    [{ timeout: 'timeout' }, { do: 'pause', reason: 'timeout' }],
    [{ timeout: 'stall' }, { do: 'pause', reason: 'stall' }],
    [{ timeout: 'no-reply' }, { do: 'pause', reason: 'no-reply' }],
  ] as const)('%j → %j', async (reply, next) => {
    const { nextAction } = await tab();
    expect(nextAction(reply, SIZE)).toEqual(next);
  });
});

describe('the upload loop', () => {
  it('confirms, queries, then sends the rest in one PUT', async () => {
    const upload = await tab();
    await started(upload);
    expect(ops()).toEqual(['confirm']);
    expect(calls[0]!.body).toEqual({ op: 'confirm', generation: 1, fingerprint: FP });
    const query = last();
    expect(query).toMatchObject({ method: 'PUT', url: URI });
    expect(query.headers['content-range']).toBe(`bytes */${SIZE}`);
    expect(query.body).toBeUndefined();
    query.respond(308, { range: 'bytes=0-99' });
    await flush();
    const put = last();
    expect(put.headers['content-range']).toBe(`bytes 100-999/${SIZE}`);
    expect(put.body!.size).toBe(900);
    expect(entryOf(upload)).toMatchObject({ saved: 100, size: SIZE, state: 'sending' });
    put.progress(450);
    expect(entryOf(upload)!.saved).toBe(550);
    put.respond(200);
    await flush();
    expect(entryOf(upload)).toMatchObject({ state: 'done', saved: SIZE });
    expect(calls.every((call) => !call.path.endsWith('/step'))).toBe(true);
    expect(locks.holders.size).toBe(0);
  });

  it('resumes a drop at 40% from the queried offset, not its own count', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(308);
    await flush();
    const put = last();
    expect(put.headers['content-range']).toBe(`bytes 0-999/${SIZE}`);
    put.progress(400);
    put.drop();
    await flush();
    expect(entryOf(upload)).toMatchObject({ state: 'paused', reason: 'offline', saved: 400 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ops()).toEqual(['confirm', 'confirm']);
    last().respond(308, { range: 'bytes=0-255' });
    await flush();
    expect(last().headers['content-range']).toBe(`bytes 256-999/${SIZE}`);
    expect(entryOf(upload)!.saved).toBe(256);
  });

  it('finishes after 20 drops with no call from the page', async () => {
    const upload = await tab();
    let saved = 0;
    let drops = 0;
    FakeXhr.handler = (xhr) => {
      if (xhr.isQuery) {
        xhr.respond(308, saved ? { range: `bytes=0-${saved - 1}` } : {});
        return;
      }
      const from = Number(/bytes (\d+)-/.exec(xhr.headers['content-range']!)![1]);
      if (drops < 20) {
        drops++;
        xhr.progress(40);
        saved = from + 32;
        xhr.drop();
        return;
      }
      xhr.progress(SIZE - from);
      xhr.respond(200);
    };
    await started(upload);
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(drops).toBe(20);
    expect(entryOf(upload)).toMatchObject({ state: 'done', saved: SIZE });
    expect(xhrs().filter((xhr) => !xhr.isQuery)).toHaveLength(21);
  });

  it('aborts a PUT that reaches 100% and never answers, then recovers through the query', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(308);
    await flush();
    const put = last();
    put.progress(SIZE);
    put.upload.onload!();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(put.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(put.aborted).toBe(true);
    expect(entryOf(upload)).toMatchObject({ state: 'paused', reason: 'no-reply' });
    await vi.advanceTimersByTimeAsync(1000);
    last().respond(200);
    await flush();
    expect(entryOf(upload)!.state).toBe('done');
  });

  it('pauses a send that stalls for 60 s', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(308);
    await flush();
    const put = last();
    put.progress(100);
    await vi.advanceTimersByTimeAsync(30_000);
    put.progress(200);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(put.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(put.aborted).toBe(true);
    expect(entryOf(upload)).toMatchObject({ state: 'paused', reason: 'stall' });
  });

  it('pauses at 15 s on a status query that never answers, before any bytes go out', async () => {
    const upload = await tab();
    await started(upload);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(entryOf(upload)!.state).toBe('sending');
    await vi.advanceTimersByTimeAsync(1);
    expect(last().aborted).toBe(true);
    expect(entryOf(upload)).toMatchObject({ state: 'paused', reason: 'timeout' });
    expect(xhrs().every((xhr) => xhr.isQuery)).toBe(true);
  });

  it('pauses at 10 s on a confirm that never answers, before any request to GCS', async () => {
    const upload = await tab();
    answer = () => new Promise(() => undefined);
    await started(upload);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(entryOf(upload)!.state).toBe('sending');
    await vi.advanceTimersByTimeAsync(1);
    expect(entryOf(upload)).toMatchObject({ state: 'paused', reason: 'timeout' });
    expect(xhrs()).toHaveLength(0);
  });

  it('doubles the backoff to a 60 s cap', async () => {
    const upload = await tab();
    FakeXhr.handler = (xhr) => xhr.drop();
    await started(upload);
    for (const wait of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
      const before = ops().length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(ops()).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(ops()).toHaveLength(before + 1);
    }
  });

  it('retries at once when the link comes back', async () => {
    const upload = await tab();
    await started(upload);
    last().drop();
    await flush();
    expect(ops()).toHaveLength(1);
    globalThis.dispatchEvent(new Event('online'));
    await flush();
    expect(ops()).toHaveLength(2);
  });

  it('starts the backoff over when the link comes back', async () => {
    const upload = await tab();
    FakeXhr.handler = (xhr) => xhr.drop();
    await started(upload);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000);
    FakeXhr.handler = (xhr) => xhr.respond(503);
    globalThis.dispatchEvent(new Event('online'));
    await flush();
    const before = ops().length;
    await vi.advanceTimersByTimeAsync(999);
    expect(ops()).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(ops()).toHaveLength(before + 1);
  });

  it('pauses as storage busy on 429 and 5xx, and as no connection on 408', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(503);
    await flush();
    expect(entryOf(upload)).toMatchObject({ state: 'paused', reason: '5xx' });
    await vi.advanceTimersByTimeAsync(1000);
    last().respond(429);
    await flush();
    expect(entryOf(upload)!.reason).toBe('429');
    await vi.advanceTimersByTimeAsync(2000);
    last().respond(408);
    await flush();
    expect(entryOf(upload)!.reason).toBe('408');
  });

  it('waits rather than looping when a PUT ends without saving more', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(308, { range: 'bytes=0-99' });
    await flush();
    last().respond(308, { range: 'bytes=0-99' });
    await flush();
    expect(entryOf(upload)).toMatchObject({ state: 'paused', reason: '5xx' });
  });

  it('goes again at once when a PUT ends with more saved', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(308);
    await flush();
    last().respond(308, { range: 'bytes=0-499' });
    await flush();
    expect(ops()).toEqual(['confirm', 'confirm']);
  });

  it('stops on another 4xx from GCS and releases the lock', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(400);
    await flush();
    expect(entryOf(upload)).toMatchObject({ state: 'stopped', error: 'Upload failed (400)' });
    expect(locks.holders.size).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ops()).toEqual(['confirm']);
  });

  it('stops on a 400 from the app', async () => {
    const upload = await tab();
    answer = () => json(400, { message: 'Pick the video again.' });
    await started(upload);
    expect(entryOf(upload)).toMatchObject({ state: 'stopped', error: 'Pick the video again.' });
  });

  it.each([
    [500, '5xx'],
    [429, '429'],
    [408, '408'],
  ] as const)('pauses on a %i from the app', async (status, reason) => {
    const upload = await tab();
    answer = () => json(status, {});
    await started(upload);
    expect(entryOf(upload)).toMatchObject({ state: 'paused', reason });
  });

  it('pauses as no connection when the app is unreachable', async () => {
    const upload = await tab();
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    await started(upload);
    expect(entryOf(upload)).toMatchObject({ state: 'paused', reason: 'offline' });
  });
});

describe('renew', () => {
  it('renews a session GCS lost and starts the new one from 0', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(308, { range: 'bytes=0-499' });
    await flush();
    last().respond(404);
    await flush();
    expect(calls.find((call) => call.body?.op === 'renew')!.body).toMatchObject({
      generation: 1,
      fingerprint: FP,
    });
    expect(entryOf(upload)).toMatchObject({
      sessionUri: URI_2,
      generation: 2,
      saved: 0,
      notice: 'renewed',
    });
    expect(calls.at(-1)!.body).toEqual({ op: 'confirm', generation: 2, fingerprint: FP });
    expect(last().url).toBe(URI_2);
  });

  it('retries a renew whose reply was lost with the same opId', async () => {
    const upload = await tab();
    await started(upload);
    let lost = true;
    answer = (call) => {
      if (call.body?.op === 'renew' && lost) {
        lost = false;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return defaultAnswer(call);
    };
    last().respond(410);
    await flush();
    expect(entryOf(upload)).toMatchObject({ state: 'paused', reason: 'offline' });
    await vi.advanceTimersByTimeAsync(1000);
    const renews = calls.filter((call) => call.body?.op === 'renew');
    expect(renews).toHaveLength(2);
    expect(renews[0]!.body!.opId).toMatch(/^[\w-]{1,64}$/);
    expect(renews[1]!.body!.opId).toBe(renews[0]!.body!.opId);
    expect(entryOf(upload)!.generation).toBe(2);
  });

  it('uses a new opId for the next renew', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(499);
    await flush();
    last().respond(404);
    await flush();
    const renews = calls.filter((call) => call.body?.op === 'renew');
    expect(renews).toHaveLength(2);
    expect(renews[1]!.body!.opId).not.toBe(renews[0]!.body!.opId);
  });
});

describe('conflicts', () => {
  it.each([
    ['A different video replaced this upload.', 'replaced'],
    ['The upload moved to another device or window.', 'moved'],
    ['This job was discarded.', 'stopped'],
    ['This upload is already done.', 'stopped'],
  ])('a 409 "%s" from the 30 s confirm aborts the PUT as %s', async (error, state) => {
    const upload = await tab();
    await started(upload);
    last().respond(308);
    await flush();
    const put = last();
    put.progress(100);
    answer = () => json(409, { error, generation: 5 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(put.aborted).toBe(true);
    expect(entryOf(upload)).toMatchObject({ state, error, generation: 5 });
    expect(locks.holders.size).toBe(0);
  });

  it('keeps the generation it had when the 409 names none', async () => {
    const upload = await tab();
    answer = () => json(409, { message: 'This job was discarded.' });
    await started(upload, SIZE, 3);
    expect(entryOf(upload)).toMatchObject({ state: 'stopped', generation: 3 });
  });

  it('pauses the PUT when the 30 s confirm times out', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(308);
    await flush();
    const put = last();
    answer = () => new Promise(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    put.progress(10);
    expect(put.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(put.aborted).toBe(true);
    expect(entryOf(upload)).toMatchObject({ state: 'paused', reason: 'timeout' });
  });
});

describe('breadcrumbs', () => {
  it('records pause and resume with saved, total and reason only', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(308);
    await flush();
    last().progress(100);
    last().drop();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    last().drop();
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    last().respond(308, { range: 'bytes=0-99' });
    await flush();
    last().progress(50);
    const crumbs = upload.sentry.addBreadcrumb.mock.calls.map(([crumb]) => crumb);
    expect(crumbs).toEqual([
      {
        category: 'upload',
        message: 'upload paused',
        data: { saved: 100, total: SIZE, reason: 'offline' },
      },
      {
        category: 'upload',
        message: 'upload resumed',
        data: { saved: 150, total: SIZE, reason: 'offline' },
      },
    ]);
    expect(JSON.stringify(crumbs)).not.toContain('upload_id');
  });
});

describe('away', () => {
  const visibility = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('says the upload paused while away until bytes flow, and retries at once', async () => {
    const upload = await tab();
    await started(upload);
    last().drop();
    await flush();
    visibility('hidden');
    visibility('visible');
    await flush();
    expect(entryOf(upload)!.state).toBe('away');
    expect(ops()).toHaveLength(2);
    last().respond(503);
    await flush();
    expect(entryOf(upload)).toMatchObject({ state: 'away', reason: '5xx' });
    await vi.advanceTimersByTimeAsync(2000);
    last().respond(308);
    await flush();
    expect(entryOf(upload)!.state).toBe('away');
    last().progress(10);
    expect(entryOf(upload)!.state).toBe('sending');
  });

  it('stays sending when bytes went out while hidden', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(308);
    await flush();
    visibility('hidden');
    last().progress(100);
    visibility('visible');
    expect(entryOf(upload)!.state).toBe('sending');
  });
});

describe('stop', () => {
  it('aborts the request in flight and sends nothing more', async () => {
    const upload = await tab();
    await started(upload);
    last().respond(308);
    await flush();
    const put = last();
    upload.stop(JOB);
    expect(put.aborted).toBe(true);
    expect(entryOf(upload)).toBeUndefined();
    await flush();
    expect(locks.holders.size).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ops()).toEqual(['confirm']);
    expect(xhrs()).toHaveLength(2);
  });

  it('ends a paused upload without another attempt', async () => {
    const upload = await tab();
    await started(upload);
    last().drop();
    await flush();
    upload.stop(JOB);
    upload.stop(JOB);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ops()).toEqual(['confirm']);
  });

  it('stops between confirm and query', async () => {
    const upload = await tab();
    let reply!: (response: Response) => void;
    answer = () => new Promise((resolve) => (reply = resolve));
    await started(upload);
    upload.stop(JOB);
    reply(json(200, { current: true }));
    await flush();
    expect(xhrs()).toHaveLength(0);
  });

  it('stops while a renew is out', async () => {
    const upload = await tab();
    await started(upload);
    let reply!: (response: Response) => void;
    answer = () => new Promise((resolve) => (reply = resolve));
    last().respond(404);
    await flush();
    upload.stop(JOB);
    reply(json(200, { sessionUri: URI_2, generation: 2, restarted: true }));
    await flush();
    expect(ops()).toEqual(['confirm', 'renew']);
    expect(entryOf(upload)).toBeUndefined();
  });

  it('restarts with a new file without releasing the lock', async () => {
    const upload = await tab();
    await started(upload);
    const query = last();
    upload.start(JOB, {
      file: file(500),
      sessionUri: URI_2,
      generation: 2,
      fingerprint: 'e'.repeat(64),
      notice: 'new-video',
    });
    expect(query.aborted).toBe(true);
    expect(locks.holders.size).toBe(1);
    await flush();
    expect(entryOf(upload)).toMatchObject({
      size: 500,
      generation: 2,
      notice: 'new-video',
      state: 'sending',
    });
    expect(last().url).toBe(URI_2);
  });
});

describe('one sender', () => {
  it('lets the holder send and refuses a second tab', async () => {
    const first = await tab();
    const second = await tab();
    expect(await first.acquire(JOB)).toBe(true);
    expect(await first.acquire(JOB)).toBe(true);
    expect(await second.acquire(JOB)).toBe(false);
  });

  it('reports another tab holding the lock, never itself', async () => {
    const first = await tab();
    const second = await tab();
    expect(await second.holder(JOB)).toBe(false);
    await first.acquire(JOB);
    expect(await second.holder(JOB)).toBe(true);
    expect(await first.holder(JOB)).toBe(false);
  });

  it('hands the lock to the queued tab once the sender stops', async () => {
    const first = await tab();
    const second = await tab();
    await started(first);
    const onTakeover = vi.fn();
    second.waitFor(JOB, new AbortController().signal, onTakeover);
    await flush();
    expect(onTakeover).not.toHaveBeenCalled();
    first.stop(JOB);
    await flush();
    expect(onTakeover).toHaveBeenCalledOnce();
    expect(await second.acquire(JOB)).toBe(true);
    expect(await first.acquire(JOB)).toBe(false);
  });

  it('never takes over from an aborted queue', async () => {
    const first = await tab();
    const second = await tab();
    await first.acquire(JOB);
    const controller = new AbortController();
    const onTakeover = vi.fn();
    second.waitFor(JOB, controller.signal, onTakeover);
    controller.abort();
    await flush();
    first.stop(JOB);
    await flush();
    expect(onTakeover).not.toHaveBeenCalled();
    expect(locks.holders.size).toBe(0);
  });

  it('releases the lock when the upload finishes', async () => {
    const first = await tab();
    const second = await tab();
    await started(first);
    last().respond(200);
    await flush();
    expect(await second.acquire(JOB)).toBe(true);
  });

  it('passes a lock manager failure to the caller', async () => {
    const upload = await tab();
    vi.spyOn(locks, 'request').mockRejectedValue(new Error('locks unavailable'));
    await expect(upload.acquire(JOB)).rejects.toThrow('locks unavailable');
  });
});

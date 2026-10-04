// @vitest-environment node
import type { RequestEvent, ResolveOptions } from '@sveltejs/kit';
// @ts-expect-error -- SvelteKit publishes no types for its internal request store.
import { with_request_store } from '@sveltejs/kit/internal/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_ANCESTORS, handle, replaceTraceMeta } from '$lib/../hooks.server';
import { SESSION_COOKIE, sessionCookie } from '$lib/server/auth';

const PAGE =
  '<html><head><meta name="sentry-trace" content="req-trace"/>\n' +
  '<meta name="baggage" content="req-baggage"/>\n<title>Soundboard</title></head><body></body></html>';

type Locals = App.Locals;

function event(cookie?: string, locals: Partial<Locals> = {}): RequestEvent {
  const url = new URL('http://localhost/jobs/j1');
  return {
    url,
    request: new Request(url),
    route: { id: '/jobs/[id]' },
    params: { id: 'j1' },
    locals: { session: null, ...locals } as Locals,
    cookies: {
      get: (name: string) => (name === SESSION_COOKIE ? cookie : undefined),
      getAll: () => [],
      set: vi.fn(),
      delete: vi.fn(),
      serialize: vi.fn(),
    },
    fetch,
    getClientAddress: () => '127.0.0.1',
    platform: undefined,
    setHeaders: vi.fn(),
    isDataRequest: false,
    isSubRequest: false,
    isRemoteRequest: false,
    tracing: { enabled: false, root: {}, current: {} },
  } as unknown as RequestEvent;
}

/** Stands in for SvelteKit's renderer: applies the page-chunk transform the hooks registered. */
function renderer(html = PAGE) {
  const seen: { locals?: Locals } = {};
  const resolve = async (ev: RequestEvent, opts?: ResolveOptions) => {
    seen.locals = ev.locals;
    const body = opts?.transformPageChunk
      ? await opts.transformPageChunk({ html, done: true })
      : html;
    return new Response(body ?? '', { headers: { 'content-type': 'text/html' } });
  };
  return { resolve, seen };
}

// SvelteKit's runtime normally opens the request store that `sequence` reads; tracing is off here.
const span = { setAttributes: () => span, setAttribute: () => span, end: () => {} };
const store = (ev: RequestEvent) => ({
  event: ev,
  state: { tracing: { record_span: ({ fn }: { fn: (s: unknown) => unknown }) => fn(span) } },
});

function run(ev: RequestEvent, resolve: ReturnType<typeof renderer>['resolve']) {
  return with_request_store(store(ev), () => handle({ event: ev, resolve }));
}

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'test-secret');
  vi.stubEnv('ALLOWLIST_EMAILS', 'nathan@example.com');
});

describe('replaceTraceMeta', () => {
  it("swaps the request's trace tags for the job's", () => {
    const out = replaceTraceMeta(PAGE, { sentryTrace: 'job-trace', baggage: 'sentry-trace_id=1' });
    expect(out).not.toContain('req-trace');
    expect(out).not.toContain('req-baggage');
    expect(out).toContain(
      '<head><meta name="sentry-trace" content="job-trace"/><meta name="baggage" content="sentry-trace_id=1"/>',
    );
    expect(out.match(/name="sentry-trace"/g)).toHaveLength(1);
    expect(out.match(/name="baggage"/g)).toHaveLength(1);
  });

  it('inserts tags when the page has none', () => {
    const out = replaceTraceMeta('<head><title>x</title></head>', {
      sentryTrace: 'a',
      baggage: 'b',
    });
    expect(out).toBe(
      '<head><meta name="sentry-trace" content="a"/><meta name="baggage" content="b"/><title>x</title></head>',
    );
  });

  it('escapes quotes, ampersands, and angle brackets in the values', () => {
    const out = replaceTraceMeta('<head></head>', {
      sentryTrace: '"><script>x</script>',
      baggage: 'a=1&b="2"',
    });
    expect(out).toContain('content="&quot;>&lt;script>x&lt;/script>"');
    expect(out).toContain('content="a=1&amp;b=&quot;2&quot;"');
    expect(out).not.toContain('<script>');
  });

  it('leaves unrelated meta tags alone', () => {
    const html = '<head><meta name="description" content="d"/></head>';
    expect(replaceTraceMeta(html, { sentryTrace: 'a', baggage: 'b' })).toContain(
      '<meta name="description" content="d"/>',
    );
  });
});

describe('handle', () => {
  it('lets the DEV post frame the app and nothing else', async () => {
    expect(FRAME_ANCESTORS).toBe("frame-ancestors 'self' https://dev.to https://*.dev.to");
    const { resolve } = renderer();
    const response = await run(event(), resolve);
    expect(response.headers.get('content-security-policy')).toBe(FRAME_ANCESTORS);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('leaves a signed-out request without a session or cookies', async () => {
    const { resolve, seen } = renderer();
    const ev = event();
    const response = await run(ev, resolve);
    expect(seen.locals?.session).toBeNull();
    expect(ev.cookies.set).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('reads an allowlisted session from its signed cookie', async () => {
    const { resolve, seen } = renderer();
    await run(event(sessionCookie('Nathan@example.com')), resolve);
    expect(seen.locals?.session).toEqual({ email: 'Nathan@example.com', allowlisted: true });
  });

  it('marks a signed-in stranger as not allowlisted', async () => {
    const { resolve, seen } = renderer();
    await run(event(sessionCookie('someone@example.com')), resolve);
    expect(seen.locals?.session).toEqual({ email: 'someone@example.com', allowlisted: false });
  });

  it('drops a tampered cookie', async () => {
    const { resolve, seen } = renderer();
    const forged = sessionCookie('nathan@example.com').replace(/\.[^.]+$/, '.forged');
    await run(event(forged), resolve);
    expect(seen.locals?.session).toBeNull();
  });

  it("renders the job's trace into the page when the job page set one", async () => {
    const { resolve } = renderer();
    const ev = event(undefined, { jobTrace: { sentryTrace: 'job-trace', baggage: 'job-bag' } });
    const html = await (await run(ev, resolve)).text();
    expect(html).toContain('<meta name="sentry-trace" content="job-trace"/>');
    expect(html).toContain('<meta name="baggage" content="job-bag"/>');
    expect(html).not.toContain('req-trace');
  });

  it('keeps the page as rendered without a job trace', async () => {
    const { resolve } = renderer();
    const html = await (await run(event(), resolve)).text();
    expect(html).toContain('req-trace');
    expect(html).not.toContain('job-trace');
  });

  it('skips chunks without a <head>', async () => {
    const { resolve } = renderer('<div>partial</div>');
    const ev = event(undefined, { jobTrace: { sentryTrace: 'job-trace', baggage: 'b' } });
    expect(await (await run(ev, resolve)).text()).toBe('<div>partial</div>');
  });
});

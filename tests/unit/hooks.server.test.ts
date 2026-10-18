// @vitest-environment node
import { isRedirect, type RequestEvent, type ResolveOptions } from '@sveltejs/kit';
// @ts-expect-error -- SvelteKit publishes no types for its internal request store.
import { with_request_store } from '@sveltejs/kit/internal/server';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, replaceTraceMeta } from '$lib/../hooks.server';
import { SESSION_COOKIE, sessionCookie } from '$lib/server/auth/auth';
import { db } from '$lib/server/core/db';
import { users } from '$lib/server/core/schema';
import { seed, truncate } from '../helpers/db';
import { USER_A, USER_B, USERS } from '../helpers/pipeline';

const PAGE =
  '<html><head><meta name="sentry-trace" content="req-trace"/>\n' +
  '<meta name="baggage" content="req-baggage"/>\n<title>Soundboard</title></head><body></body></html>';

type Locals = RequestEvent['locals'];

function event(
  cookie?: string,
  locals: Partial<Locals> = {},
  path = '/jobs/j1',
  isDataRequest = false,
): RequestEvent {
  const url = new URL(`http://localhost${path}`);
  return {
    request: new Request(url),
    route: { id: null },
    params: {},
    locals: { user: null, ...locals } as Locals,
    cookies: {
      get: (name: string) => (name === SESSION_COOKIE ? cookie : undefined),
      getAll: () => [],
      set: vi.fn(),
      delete: vi.fn(),
      serialize: vi.fn(),
    },
    getClientAddress: () => '127.0.0.1',
    setHeaders: vi.fn(),
    isDataRequest,
    isSubRequest: false,
    isRemoteRequest: false,
    tracing: { enabled: false, root: {}, current: {} },
    url,
    fetch,
  } as unknown as RequestEvent;
}

/** Stands in for SvelteKit's renderer: applies the page-chunk transform the hooks registered. */
function renderer(html = PAGE) {
  const seen: { locals?: Locals; resolved: number } = { resolved: 0 };
  const resolve = async (ev: RequestEvent, opts?: ResolveOptions) => {
    seen.resolved += 1;
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

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', 'test-secret');
  await truncate();
  await seed(USERS);
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
  it('lets only the app itself frame its pages', async () => {
    const { resolve } = renderer();
    const response = await run(event(sessionCookie(USER_A.uid, 1)), resolve);
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('leaves a signed-out request without a user or cookies', async () => {
    const { resolve, seen } = renderer();
    const ev = event(undefined, {}, '/');
    const response = await run(ev, resolve);
    expect(seen.locals?.user).toBeNull();
    expect(ev.cookies.set).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('resolves the user from a signed session at their access generation', async () => {
    const { resolve, seen } = renderer();
    await run(event(sessionCookie(USER_A.uid, 1)), resolve);
    expect(seen.locals?.user).toEqual(USER_A);
  });

  it('resolves an unlinked user with a null artist', async () => {
    const { resolve, seen } = renderer();
    await run(event(sessionCookie(USER_B.uid, 1)), resolve);
    expect(seen.locals?.user).toEqual(USER_B);
  });

  it('signs out a session from before the access generation was bumped', async () => {
    await db().update(users).set({ accessGeneration: 2 }).where(eq(users.uid, USER_A.uid));
    const { resolve, seen } = renderer();
    await run(event(sessionCookie(USER_A.uid, 1), {}, '/'), resolve);
    expect(seen.locals?.user).toBeNull();
  });

  it('signs out a session whose user no longer exists', async () => {
    const { resolve, seen } = renderer();
    await run(event(sessionCookie('uid-gone', 1), {}, '/'), resolve);
    expect(seen.locals?.user).toBeNull();
  });

  it('drops a tampered cookie', async () => {
    const { resolve, seen } = renderer();
    const forged = sessionCookie(USER_A.uid, 1).replace(/\.[^.]+$/, '.forged');
    await run(event(forged, {}, '/'), resolve);
    expect(seen.locals?.user).toBeNull();
  });

  it("renders the job's trace into the page when the job page set one", async () => {
    const { resolve } = renderer();
    const ev = event(sessionCookie(USER_A.uid, 1), {
      jobTrace: { sentryTrace: 'job-trace', baggage: 'job-bag' },
    });
    const html = await (await run(ev, resolve)).text();
    expect(html).toContain('<meta name="sentry-trace" content="job-trace"/>');
    expect(html).toContain('<meta name="baggage" content="job-bag"/>');
    expect(html).not.toContain('req-trace');
  });

  it('keeps the page as rendered without a job trace', async () => {
    const { resolve } = renderer();
    const html = await (await run(event(undefined, {}, '/'), resolve)).text();
    expect(html).toContain('req-trace');
    expect(html).not.toContain('job-trace');
  });

  it('skips chunks without a <head>', async () => {
    const { resolve } = renderer('<div>partial</div>');
    const ev = event(sessionCookie(USER_A.uid, 1), {
      jobTrace: { sentryTrace: 'job-trace', baggage: 'b' },
    });
    expect(await (await run(ev, resolve)).text()).toBe('<div>partial</div>');
  });
});

// Every route file in the app, as the URL a request would use (`[param]` → `x`).
const ROUTES = Object.keys(
  import.meta.glob(['/src/routes/**/+page*.{ts,svelte}', '/src/routes/**/+server.ts']),
)
  .map((file) =>
    file
      .replace(/^\/src\/routes/, '')
      .replace(/\/\+(page|server)[^/]*$/, '')
      .replaceAll(/\[[^\]]+\]/g, 'x'),
  )
  .map((path) => path || '/');
const PATHS = [...new Set(ROUTES)];
const EXEMPT = ['/', '/auth/login', '/auth/callback', '/auth/logout', '/health'];
const CSP = "frame-ancestors 'self'";

describe('gate', () => {
  it('sweeps every exempt route and some gated ones', () => {
    expect(PATHS).toEqual(expect.arrayContaining([...EXEMPT, '/brand', '/jobs/x', '/api/jobs']));
  });

  it.each(EXEMPT)('lets a signed-out request reach %s', async (path) => {
    const { resolve, seen } = renderer();
    const response = await run(event(undefined, {}, path), resolve);
    expect(seen.resolved).toBe(1);
    expect(seen.locals?.user).toBeNull();
    expect(response.headers.get('content-security-policy')).toBe(CSP);
  });

  it.each(PATHS.filter((p) => !EXEMPT.includes(p) && !p.startsWith('/api/')))(
    'redirects a signed-out page request for %s home',
    async (path) => {
      const { resolve, seen } = renderer();
      const response = await run(event(undefined, {}, path), resolve);
      expect(seen.resolved).toBe(0);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/');
      expect(response.headers.get('content-security-policy')).toBe(CSP);
    },
  );

  it.each(PATHS.filter((p) => p.startsWith('/api/')))(
    'answers a signed-out %s with 401 and never runs the route',
    async (path) => {
      const { resolve, seen } = renderer();
      const response = await run(event(undefined, {}, path), resolve);
      expect(seen.resolved).toBe(0);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ message: 'Sign in first.' });
      expect(response.headers.get('content-security-policy')).toBe(CSP);
    },
  );

  it.each(['/api', '/connections', '/nowhere', '/healthz', '/auth', '/auth/login/x'])(
    'gates %s, which is no exempt path',
    async (path) => {
      const { resolve, seen } = renderer();
      const response = await run(event(undefined, {}, path), resolve);
      expect(seen.resolved).toBe(0);
      expect(response.status).toBe(path === '/api' ? 401 : 303);
    },
  );

  it("sends a signed-out client navigation home through SvelteKit's redirect", async () => {
    const { resolve, seen } = renderer();
    const thrown = await run(event(undefined, {}, '/jobs/x', true), resolve).catch(
      (e: unknown) => e,
    );
    expect(isRedirect(thrown) && [thrown.status, thrown.location]).toEqual([303, '/']);
    expect(seen.resolved).toBe(0);
  });

  it.each(PATHS)('lets a signed-in request reach %s', async (path) => {
    const { resolve, seen } = renderer();
    await run(event(sessionCookie(USER_B.uid, 1), {}, path), resolve);
    expect(seen.resolved).toBe(1);
    expect(seen.locals?.user).toEqual(USER_B);
  });

  it('gates a revoked session like no session', async () => {
    await db().update(users).set({ accessGeneration: 2 }).where(eq(users.uid, USER_A.uid));
    const { resolve } = renderer();
    const response = await run(event(sessionCookie(USER_A.uid, 1), {}, '/api/jobs'), resolve);
    expect(response.status).toBe(401);
  });
});

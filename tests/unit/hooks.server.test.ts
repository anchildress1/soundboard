// @vitest-environment node
import { captureMessage } from '@sentry/sveltekit';
import type { RequestEvent, ResolveOptions } from '@sveltejs/kit';
// @ts-expect-error -- SvelteKit publishes no types for its internal request store.
import { with_request_store } from '@sveltejs/kit/internal/server';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, replaceTraceMeta } from '$lib/../hooks.server';
import { readSession, SESSION_COOKIE, sessionCookie } from '$lib/server/auth/auth';
import { db } from '$lib/server/core/db';
import { users } from '$lib/server/core/schema';
import { reactivate, revoke } from '../../scripts/invite';
import { client, seed, truncate } from '../helpers/db';
import { USER_A, USER_B, USERS } from '../helpers/pipeline';

const PAGE =
  '<html><head><meta name="sentry-trace" content="req-trace"/>\n' +
  '<meta name="baggage" content="req-baggage"/>\n<title>Soundboard</title></head><body></body></html>';

type Locals = RequestEvent['locals'];

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const JOB_TRACE = `${TRACE_ID}-0123456789abcdef-1`;
const JOB_BAGGAGE = `sentry-trace_id=${TRACE_ID},sentry-environment=production,sentry-release=soundboard%401.0.0`;

/** The locals `cookie` resolves to for `user`, carrying that cookie's own sid. */
const signedIn = (user: typeof USER_A | typeof USER_B, cookie: string) => ({
  ...user,
  sid: readSession(cookie)!.sid,
});

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
  beforeEach(() => vi.mocked(captureMessage).mockClear());

  const head = '<head><title>x</title></head>';
  const tags = (trace: string, baggage: string) =>
    `<head><meta name="sentry-trace" content="${trace}"/><meta name="baggage" content="${baggage}"/>`;

  it("swaps the request's trace tags for the job's", () => {
    const out = replaceTraceMeta(PAGE, { sentryTrace: JOB_TRACE, baggage: JOB_BAGGAGE }, 'j1');
    expect(out).not.toContain('req-trace');
    expect(out).not.toContain('req-baggage');
    expect(out).toContain(tags(JOB_TRACE, JOB_BAGGAGE));
    expect(out.match(/name="sentry-trace"/g)).toHaveLength(1);
    expect(out.match(/name="baggage"/g)).toHaveLength(1);
    expect(vi.mocked(captureMessage)).not.toHaveBeenCalled();
  });

  it('inserts tags when the page has none', () => {
    const out = replaceTraceMeta(head, { sentryTrace: JOB_TRACE, baggage: JOB_BAGGAGE }, 'j1');
    expect(out).toBe(`${tags(JOB_TRACE, JOB_BAGGAGE)}<title>x</title></head>`);
  });

  it.each([
    ['sampled', `${TRACE_ID}-0123456789abcdef-1`],
    ['unsampled', `${TRACE_ID}-0123456789abcdef-0`],
    ['no sampling decision', `${TRACE_ID}-0123456789abcdef`],
  ])('accepts a %s sentry-trace', (_label, sentryTrace) => {
    const out = replaceTraceMeta(head, { sentryTrace, baggage: JOB_BAGGAGE }, 'j1');
    expect(out).toContain(`content="${sentryTrace}"`);
  });

  it('accepts empty baggage, which getTraceData yields without a DSC', () => {
    const out = replaceTraceMeta(head, { sentryTrace: JOB_TRACE, baggage: '' }, 'j1');
    expect(out).toBe(`${tags(JOB_TRACE, '')}<title>x</title></head>`);
  });

  it.each([
    ['markup', '"><script>x</script>'],
    ['uppercase hex', `${TRACE_ID.toUpperCase()}-0123456789abcdef-1`],
    ['a short trace id', '0123456789abcdef-0123456789abcdef-1'],
    ['a sampled flag other than 0 or 1', `${TRACE_ID}-0123456789abcdef-2`],
    ['trailing text', `${JOB_TRACE} `],
    ['an empty value', ''],
  ])('keeps the page as rendered when sentry-trace has %s', (_label, sentryTrace) => {
    expect(replaceTraceMeta(PAGE, { sentryTrace, baggage: JOB_BAGGAGE }, 'j1')).toBe(PAGE);
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith(
      'Job trace dropped: malformed sentry-trace or baggage',
      { level: 'warning', tags: { 'job.id': 'j1' } },
    );
  });

  it.each([
    ['a double quote', 'sentry-a="1"'],
    ['an angle bracket', 'sentry-a=<script>'],
    ['an ampersand', 'sentry-a=1&b=2'],
    ['whitespace', 'sentry-a=1, sentry-b=2'],
    ['a member without a value separator', 'sentry-a'],
    ['an empty member', 'sentry-a=1,,sentry-b=2'],
    ['a property', 'sentry-a=1;p'],
  ])('keeps the page as rendered when baggage has %s', (_label, baggage) => {
    expect(replaceTraceMeta(PAGE, { sentryTrace: JOB_TRACE, baggage }, 'j1')).toBe(PAGE);
    expect(vi.mocked(captureMessage)).toHaveBeenCalledTimes(1);
  });

  it('reports a dropped trace without its raw value', () => {
    replaceTraceMeta(PAGE, { sentryTrace: JOB_TRACE, baggage: 'sentry-secret="x"' }, 'j1');
    expect(JSON.stringify(vi.mocked(captureMessage).mock.calls)).not.toContain('secret');
  });

  it('leaves unrelated meta tags alone', () => {
    const html = '<head><meta name="description" content="d"/></head>';
    expect(
      replaceTraceMeta(html, { sentryTrace: JOB_TRACE, baggage: JOB_BAGGAGE }, 'j1'),
    ).toContain('<meta name="description" content="d"/>');
  });
});

describe('handle', () => {
  it('lets only the app itself frame its pages', async () => {
    const { resolve } = renderer();
    const response = await run(event(sessionCookie(USER_A.uid)), resolve);
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

  it('resolves the active user from a signed session', async () => {
    const { resolve, seen } = renderer();
    const cookie = sessionCookie(USER_A.uid);
    await run(event(cookie), resolve);
    expect(seen.locals?.user).toEqual(signedIn(USER_A, cookie));
  });

  it('resolves an unlinked user with a null artist', async () => {
    const { resolve, seen } = renderer();
    const cookie = sessionCookie(USER_B.uid);
    await run(event(cookie), resolve);
    expect(seen.locals?.user).toEqual(signedIn(USER_B, cookie));
  });

  it('signs out a session whose user was deactivated', async () => {
    await db().update(users).set({ active: false }).where(eq(users.uid, USER_A.uid));
    const { resolve, seen } = renderer();
    await run(event(sessionCookie(USER_A.uid), {}, '/'), resolve);
    expect(seen.locals?.user).toBeNull();
  });

  it('reads email and artist from the row, not the cookie', async () => {
    await db()
      .update(users)
      .set({ email: 'moved@example.com', artistId: null })
      .where(eq(users.uid, USER_A.uid));
    const { resolve, seen } = renderer();
    const cookie = sessionCookie(USER_A.uid);
    await run(event(cookie), resolve);
    expect(seen.locals?.user).toMatchObject({ email: 'moved@example.com', artistId: null });
  });

  it('signs out an expired session even while the user is active', async () => {
    const { resolve, seen } = renderer();
    await run(event(sessionCookie(USER_A.uid, 0), {}, '/'), resolve);
    expect(seen.locals?.user).toBeNull();
  });

  it('signs out a session whose user no longer exists', async () => {
    const { resolve, seen } = renderer();
    await run(event(sessionCookie('uid-gone'), {}, '/'), resolve);
    expect(seen.locals?.user).toBeNull();
  });

  it('drops a tampered cookie', async () => {
    const { resolve, seen } = renderer();
    const forged = sessionCookie(USER_A.uid).replace(/\.[^.]+$/, '.forged');
    await run(event(forged, {}, '/'), resolve);
    expect(seen.locals?.user).toBeNull();
  });

  it("renders the job's trace into the page when the job page set one", async () => {
    const { resolve } = renderer();
    const ev = event(sessionCookie(USER_A.uid), {
      jobTrace: { sentryTrace: JOB_TRACE, baggage: JOB_BAGGAGE },
    });
    const html = await (await run(ev, resolve)).text();
    expect(html).toContain(`<meta name="sentry-trace" content="${JOB_TRACE}"/>`);
    expect(html).toContain(`<meta name="baggage" content="${JOB_BAGGAGE}"/>`);
    expect(html).not.toContain('req-trace');
  });

  it("reports a malformed job trace tagged with the page's job", async () => {
    const { resolve } = renderer();
    const ev = event(sessionCookie(USER_A.uid), {
      jobTrace: { sentryTrace: 'bad', baggage: JOB_BAGGAGE },
    });
    ev.params = { id: 'j1' };
    expect(await (await run(ev, resolve)).text()).toContain('req-trace');
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith(
      'Job trace dropped: malformed sentry-trace or baggage',
      { level: 'warning', tags: { 'job.id': 'j1' } },
    );
  });

  it('keeps the page as rendered without a job trace', async () => {
    const { resolve } = renderer();
    const html = await (await run(event(undefined, {}, '/'), resolve)).text();
    expect(html).toContain('req-trace');
    expect(html).not.toContain(JOB_TRACE);
  });

  it('skips chunks without a <head>', async () => {
    const { resolve } = renderer('<div>partial</div>');
    const ev = event(sessionCookie(USER_A.uid), {
      jobTrace: { sentryTrace: JOB_TRACE, baggage: JOB_BAGGAGE },
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
const EXEMPT = [
  '/',
  '/privacy',
  '/terms',
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
  '/auth/signed-out',
  '/health',
];
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

  it.each(['/jobs/x', '/'])(
    'sends a signed-out client navigation to %s through /auth/signed-out for a full page load',
    async (path) => {
      const { resolve, seen } = renderer();
      const response = await run(event(undefined, {}, path, true), resolve);
      expect([response.status, response.headers.get('location')]).toEqual([
        303,
        '/auth/signed-out',
      ]);
      expect(seen.resolved).toBe(0);
    },
  );

  it('lets a signed-in client navigation through without the signed-out bounce', async () => {
    const { resolve, seen } = renderer();
    const cookie = sessionCookie(USER_B.uid);
    await run(event(cookie, {}, '/jobs/x', true), resolve);
    expect(seen.resolved).toBe(1);
  });

  it.each(PATHS)('lets a signed-in request reach %s', async (path) => {
    const { resolve, seen } = renderer();
    const cookie = sessionCookie(USER_B.uid);
    await run(event(cookie, {}, path), resolve);
    expect(seen.resolved).toBe(1);
    expect(seen.locals?.user).toEqual(signedIn(USER_B, cookie));
  });

  it('gates a deactivated session like no session', async () => {
    await db().update(users).set({ active: false }).where(eq(users.uid, USER_A.uid));
    const { resolve } = renderer();
    const response = await run(event(sessionCookie(USER_A.uid), {}, '/api/jobs'), resolve);
    expect(response.status).toBe(401);
  });
});

describe('revoke and reactivate', () => {
  const signedInAs = async (cookie: string) => {
    const { resolve, seen } = renderer();
    await run(event(cookie, {}, '/'), resolve);
    return seen.locals?.user ?? null;
  };

  it('signs a user out on the next request once they are revoked', async () => {
    const cookie = sessionCookie(USER_A.uid);
    expect(await signedInAs(cookie)).toEqual(signedIn(USER_A, cookie));
    await revoke(client(), USER_A.email);
    expect(await signedInAs(cookie)).toBeNull();
  });

  it('keeps other users signed in when one is revoked', async () => {
    await revoke(client(), USER_A.email);
    const cookie = sessionCookie(USER_B.uid);
    expect(await signedInAs(cookie)).toEqual(signedIn(USER_B, cookie));
  });

  it('revives an unexpired cookie once the user is reactivated', async () => {
    const cookie = sessionCookie(USER_A.uid);
    await revoke(client(), USER_A.email);
    expect(await signedInAs(cookie)).toBeNull();
    await reactivate(client(), USER_A.email);
    expect(await signedInAs(cookie)).toEqual(signedIn(USER_A, cookie));
  });
});

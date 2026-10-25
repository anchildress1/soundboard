import { captureMessage, handleErrorWithSentry, sentryHandle } from '@sentry/sveltekit';
import { sequence, type Handle } from '@sveltejs/kit/hooks';
import { readSession, SESSION_COOKIE } from '#lib/server/auth/auth.js';
import { getUser } from '#lib/server/auth/users.js';
import { withIdentity } from '#lib/server/core/identity.js';

const SENTRY_TRACE = /^[0-9a-f]{32}-[0-9a-f]{16}(?:-[01])?$/;
// Stricter than W3C baggage, which allows raw `&`, `<`, and `>`: Sentry percent-encodes values with
// encodeURIComponent, so nothing it writes needs escaping inside a double-quoted attribute.
const BAGGAGE = /^(?:[\w.-]+=[\w%.!~*'()-]*(?:,[\w.-]+=[\w%.!~*'()-]*)*)?$/;

/**
 * Swaps the request's trace meta tags for the job's, so the browser continues the job's trace.
 * Returns the page unchanged when either value is not one Sentry's `getTraceData()` could write;
 * `jobId` only tags that drop report.
 */
export function replaceTraceMeta(
  html: string,
  trace: { sentryTrace: string; baggage: string },
  jobId: string | undefined,
): string {
  // Values come from `getTraceData()` at job creation, but round-trip through the database first.
  if (!SENTRY_TRACE.test(trace.sentryTrace) || !BAGGAGE.test(trace.baggage)) {
    captureMessage('Job trace dropped: malformed sentry-trace or baggage', {
      level: 'warning',
      tags: { 'job.id': jobId },
    });
    return html;
  }
  const stripped = html.replaceAll(/<meta name="(?:sentry-trace|baggage)"[^>]*>\s*/g, '');
  const tags =
    `<meta name="sentry-trace" content="${trace.sentryTrace}"/>` +
    `<meta name="baggage" content="${trace.baggage}"/>`;
  return stripped.replace('<head>', `<head>${tags}`);
}

// Runs outside sentryHandle: SvelteKit applies inner transforms first, so this sees Sentry's tags.
const jobTraceMeta: Handle = ({ event, resolve }) =>
  resolve(event, {
    transformPageChunk: ({ html }) => {
      const trace = event.locals.jobTrace;
      return trace && html.includes('<head>')
        ? replaceTraceMeta(html, trace, event.params.id)
        : html;
    },
  });

/** A session counts only while its user is active, so deactivating signs them out everywhere. */
const session: Handle = async ({ event, resolve }) => {
  const signed = readSession(event.cookies.get(SESSION_COOKIE));
  return await withIdentity(signed?.uid, async () => {
    const user = signed ? await getUser(signed.uid) : null;
    event.locals.user =
      user && signed
        ? { uid: user.uid, sid: signed.sid, email: user.email, artist: user.artist }
        : null;
    return resolve(event);
  });
};

/**
 * Paths a signed-out page load may reach; every other page, every data request, and every API
 * needs a session.
 */
const OPEN = new Set([
  '/',
  '/privacy',
  '/terms',
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
  '/auth/signed-out',
  '/health',
]);

const RESEARCH_TASK = '/api/research/task';

const gate: Handle = ({ event, resolve }) => {
  const { pathname } = event.url;
  if (event.locals.user) return resolve(event);
  // A client-side navigation, even to `/`, keeps its cached signed-in layout, so every data request
  // goes through a server-only route that forces a full page load.
  if (event.isDataRequest)
    return new Response(null, { status: 303, headers: { location: '/auth/signed-out' } });
  if (OPEN.has(pathname)) return resolve(event);
  // Cloud Tasks has no session: the route checks the queue's OIDC token itself.
  if (pathname === RESEARCH_TASK && event.request.method === 'POST') return resolve(event);
  if (pathname === '/api' || pathname.startsWith('/api/'))
    return Response.json({ message: 'Sign in first.' }, { status: 401 });
  return new Response(null, { status: 303, headers: { location: '/' } });
};

const securityHeaders: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('content-security-policy', "frame-ancestors 'self'");
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  return response;
};

// The gate runs inside securityHeaders so its own 303 and 401 responses carry them too, except a
// data request's 303: SvelteKit replaces it with a fresh JSON redirect after every hook ran.
// The fetch proxy puts Sentry's fetch wrapper under SvelteKit's. Over it, Sentry copies each
// request's options and drops SvelteKit's own-fetch flag, so dev warns on every `__data.json` load.
export const handle = sequence(
  jobTraceMeta,
  sentryHandle({ injectFetchProxyScript: true }),
  session,
  securityHeaders,
  gate,
);

export const handleError = handleErrorWithSentry();

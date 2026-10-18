import { handleErrorWithSentry, sentryHandle } from '@sentry/sveltekit';
import { json, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { readSession, SESSION_COOKIE } from '$lib/server/auth/auth';
import { getUser } from '$lib/server/auth/users';

const escapeAttr = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/** Swaps the request's trace meta tags for the job's, so the browser continues the job's trace. */
export function replaceTraceMeta(
  html: string,
  trace: { sentryTrace: string; baggage: string },
): string {
  const stripped = html.replaceAll(/<meta name="(?:sentry-trace|baggage)"[^>]*>\s*/g, '');
  const tags =
    `<meta name="sentry-trace" content="${escapeAttr(trace.sentryTrace)}"/>` +
    `<meta name="baggage" content="${escapeAttr(trace.baggage)}"/>`;
  return stripped.replace('<head>', `<head>${tags}`);
}

// Runs outside sentryHandle: SvelteKit applies inner transforms first, so this sees Sentry's tags.
const jobTraceMeta: Handle = ({ event, resolve }) =>
  resolve(event, {
    transformPageChunk: ({ html }) => {
      const trace = event.locals.jobTrace;
      return trace && html.includes('<head>') ? replaceTraceMeta(html, trace) : html;
    },
  });

/** A session counts only while its user exists at the same access generation; revoking bumps it. */
const session: Handle = async ({ event, resolve }) => {
  const signed = readSession(event.cookies.get(SESSION_COOKIE));
  const user = signed ? await getUser(signed.uid) : null;
  event.locals.user =
    user && signed?.gen === user.accessGeneration
      ? { uid: user.uid, sid: signed.sid, email: user.email, artistId: user.artistId }
      : null;
  return resolve(event);
};

/** Paths a signed-out request may reach; every other page and every API needs a session. */
const OPEN = new Set([
  '/',
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
  '/auth/signed-out',
  '/health',
]);

const gate: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;
  if (event.locals.user || OPEN.has(pathname)) return resolve(event);
  if (pathname === '/api' || pathname.startsWith('/api/'))
    return json({ message: 'Sign in first.' }, { status: 401 });
  // A client-side navigation would follow a redirect to `/` in place and keep its cached signed-in
  // layout, so its data request goes through a server-only route that forces a full page load.
  const location = event.isDataRequest ? '/auth/signed-out' : '/';
  return new Response(null, { status: 303, headers: { location } });
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
export const handle = sequence(jobTraceMeta, sentryHandle(), session, securityHeaders, gate);

export const handleError = handleErrorWithSentry();

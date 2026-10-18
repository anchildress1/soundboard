import { handleErrorWithSentry, sentryHandle } from '@sentry/sveltekit';
import type { Handle } from '@sveltejs/kit';
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
      ? { uid: user.uid, email: user.email, artistId: user.artistId }
      : null;
  return resolve(event);
};

/** The DEV post embeds the app; everything else is refused as a frame parent. */
const FRAME_ANCESTORS = "frame-ancestors 'self' https://dev.to https://*.dev.to";

const securityHeaders: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('content-security-policy', FRAME_ANCESTORS);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  return response;
};

export const handle = sequence(jobTraceMeta, sentryHandle(), session, securityHeaders);

export const handleError = handleErrorWithSentry();

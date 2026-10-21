import { json } from '@sveltejs/kit';
import { revokeGrant } from '$lib/server/platforms/youtube';
import type { RequestHandler } from './$types';

/**
 * Revokes the caller's YouTube grant at Google and forgets it; any publish in flight waits for a
 * reconnect.
 */
export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json({ message: 'Sign in first.' }, { status: 401 });
  return json({ revokedAtGoogle: await revokeGrant(locals.user.uid) });
};

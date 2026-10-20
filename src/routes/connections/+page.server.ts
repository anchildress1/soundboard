import { redirect } from '@sveltejs/kit';
import { getConnection } from '$lib/server/platforms/youtube';
import type { PageServerLoad } from './$types';

/** Outcomes the connect callback names in `?connect=`; anything else shows nothing. */
const NOTICES = ['missing_scopes', 'no_channel', 'mismatch', 'wrong-account', 'failed'] as const;

export const load: PageServerLoad = async ({ locals, url }) => {
  // Narrows locals.user; the gate already sends signed-out page loads home.
  if (!locals.user) redirect(303, '/');
  const connection = await getConnection(locals.user.uid);
  const notice = url.searchParams.get('connect');
  return {
    youtube: connection && {
      status: connection.status,
      channelTitle: connection.channelTitle,
      channelId: connection.channelId,
    },
    notice: NOTICES.find((n) => n === notice) ?? null,
  };
};

import { redirect } from '@sveltejs/kit';
import { analyticsShared, getConnection } from '#lib/server/platforms/youtube/index.js';
import type { PageServerLoad } from './$types';

/** Outcomes the connect callback names in `?connect=`; anything else shows nothing. */
const ANALYTICS_NOTICES = ['shared', 'declined'] as const;

const NOTICES = ['missing_scopes', 'no_channel', 'mismatch', 'wrong-account', 'failed'] as const;

export const load: PageServerLoad = async ({ locals, url }) => {
  // Narrows locals.user; the gate already sends signed-out page loads home.
  if (!locals.user) redirect(303, '/');
  const connection = await getConnection(locals.user.uid);
  const notice = url.searchParams.get('connect');
  const analytics = url.searchParams.get('analytics');
  return {
    youtube: connection && {
      status: connection.status,
      channelTitle: connection.channelTitle,
      channelId: connection.channelId,
      analytics: analyticsShared(connection),
    },
    notice: NOTICES.find((n) => n === notice) ?? null,
    analyticsNotice: ANALYTICS_NOTICES.find((n) => n === analytics) ?? null,
  };
};

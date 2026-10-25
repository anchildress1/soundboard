import { captureException } from '@sentry/sveltekit';
import {
  channelStats,
  getConnection,
  type ChannelStats,
} from '#lib/server/platforms/youtube/index.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  const { user } = locals;
  let channel: ChannelStats | null = null;
  const connection = user ? await getConnection(user.uid) : null;
  if (connection?.status === 'connected') {
    try {
      channel = await channelStats(connection.channelId);
    } catch (error) {
      // Stats are optional: report the failure, render the header without them.
      captureException(error, { tags: { component: 'header-stats' } });
    }
  }
  return {
    channel,
    user: user ? { email: user.email, artistId: user.artistId } : null,
  };
};

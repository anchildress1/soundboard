import { captureException } from '@sentry/sveltekit';
import { channelStats, getConnection, type ChannelStats } from '$lib/server/platforms/youtube';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  const { user } = locals;
  let channel: ChannelStats | null = null;
  const connection = user ? await getConnection(user.uid) : null;
  if (connection?.status === 'connected') {
    try {
      channel = await channelStats(connection.channelId);
    } catch (error) {
      // The header renders without stats when the read key or channel is unavailable.
      captureException(error, { tags: { component: 'header-stats' } });
    }
  }
  return {
    channel,
    connected: connection?.status === 'connected',
    user: user ? { email: user.email, artistId: user.artistId } : null,
  };
};

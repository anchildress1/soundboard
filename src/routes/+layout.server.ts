import { channelStats, getConnection, type ChannelStats } from '$lib/server/platforms/youtube';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  const { user } = locals;
  let channel: ChannelStats | null = null;
  if (user) {
    const connection = await getConnection(user.uid);
    if (connection?.status === 'connected' && connection.channelId) {
      try {
        channel = await channelStats(connection.channelId);
      } catch {
        // The header renders without stats when the read key or channel is unavailable.
      }
    }
  }
  return { channel, user: user ? { email: user.email, artistId: user.artistId } : null };
};

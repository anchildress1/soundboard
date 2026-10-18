import { ARTIST_ID } from '$lib/server/artist/memory';
import { channelStats, type ChannelStats } from '$lib/server/platforms/youtube';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  const { user } = locals;
  let channel: ChannelStats | null = null;
  // The header's stats are Nathan's channel, so only his artist's users see them.
  if (user?.artistId === ARTIST_ID) {
    try {
      channel = await channelStats();
    } catch {
      // The header renders without stats when the read key or channel is unavailable.
    }
  }
  return { channel, user: user ? { email: user.email, artistId: user.artistId } : null };
};

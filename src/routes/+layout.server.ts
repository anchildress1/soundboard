import { channelStats, type ChannelStats } from '$lib/server/youtube';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  let channel: ChannelStats | null = null;
  try {
    channel = await channelStats();
  } catch {
    // The header renders without stats when the read key or channel is unavailable.
  }
  return {
    channel,
    session: locals.session
      ? {
          email: locals.session.email,
          allowlisted: locals.session.allowlisted,
          demo: locals.session.demo,
        }
      : null,
  };
};

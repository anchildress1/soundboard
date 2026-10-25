// Preloaded into the E2E preview server (playwright.config.ts): refreshes the fixture grants and
// answers each owner's own upload reads through them, so the pick and the brand guide reach their
// model call. Any other YouTube read fails, as it does with no network.
import { OAuth2Client } from 'google-auth-library';

const API = 'https://www.googleapis.com/youtube/v3/';
/** Each fixture grant's channel (tests/helpers/pipeline.ts), by the token its refresh mints. */
const CHANNELS = new Map([
  ['Bearer e2e-access:refresh-a', 'UCflr'],
  ['Bearer e2e-access:refresh-c', 'UCtest'],
]);
const VIDEOS = ['e2e-upload-1', 'e2e-upload-2'];
const realFetch = globalThis.fetch;

// Gaxios refreshes through node-fetch, which the fetch patch below never sees.
OAuth2Client.prototype.getAccessToken = async function (this: OAuth2Client) {
  return { token: `e2e-access:${this.credentials.refresh_token}` };
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function answer(url: URL, channel: string | undefined): Response | null {
  if (!channel) return null;
  const params = url.searchParams;
  switch (url.pathname.slice('/youtube/v3/'.length)) {
    case 'channels':
      return params.get('mine') === 'true'
        ? json({
            items: [
              { id: channel, contentDetails: { relatedPlaylists: { uploads: `UU${channel}` } } },
            ],
          })
        : null;
    case 'playlistItems':
      return params.get('playlistId') === `UU${channel}`
        ? json({ items: VIDEOS.map((videoId) => ({ contentDetails: { videoId } })) })
        : null;
    case 'videos': {
      const ids = (params.get('id') ?? '').split(',');
      if (!ids.every((id) => VIDEOS.includes(id))) return null;
      // No thumbnails, so the requests send no image fetch.
      return json({ items: ids.map((id) => ({ id, snippet: { title: `Song ${id}` } })) });
    }
    default:
      return null;
  }
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(API)) return realFetch(input, init);
  const auth = new Headers(init?.headers).get('authorization') ?? undefined;
  const reply = answer(new URL(url), auth && CHANNELS.get(auth));
  if (!reply) throw new Error(`Unhandled YouTube request in E2E: ${url}`);
  return reply;
};

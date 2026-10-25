// Preloaded into the E2E preview server (playwright.config.ts): answers the YouTube Data API key
// reads of the artist channel's uploads, so the brand guide reaches its model call. Any other
// YouTube read fails, as it does with no network.
const API = 'https://www.googleapis.com/youtube/v3/';
const CHANNEL = 'UC-e2e-artist';
const UPLOADS = 'UU-e2e-artist';
const VIDEOS = ['e2e-upload-1', 'e2e-upload-2'];
const realFetch = globalThis.fetch;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function answer(url: URL): Response | null {
  const params = url.searchParams;
  switch (url.pathname.slice('/youtube/v3/'.length)) {
    case 'channels':
      return params.get('id') === CHANNEL
        ? json({ items: [{ contentDetails: { relatedPlaylists: { uploads: UPLOADS } } }] })
        : null;
    case 'playlistItems':
      return params.get('playlistId') === UPLOADS
        ? json({ items: VIDEOS.map((videoId) => ({ contentDetails: { videoId } })) })
        : null;
    case 'videos': {
      const ids = (params.get('id') ?? '').split(',');
      if (!ids.every((id) => VIDEOS.includes(id))) return null;
      // No thumbnails, so the brand request sends no image fetch.
      return json({ items: ids.map((id) => ({ id, snippet: { title: `Song ${id}` } })) });
    }
    default:
      return null;
  }
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(API)) return realFetch(input, init);
  const reply = answer(new URL(url));
  if (!reply) throw new Error(`Unhandled YouTube request in E2E: ${url}`);
  return reply;
};

// A module, so its names don't clash with the other preload's in the type check.
export {};

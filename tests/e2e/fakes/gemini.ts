// Preloaded into the E2E preview server (playwright.config.ts): answers Gemini HTTP so the real AI
// SDK and model client run with a dummy key and no network. Every model call gets a busy 429, so
// analyze, pick and hook steps end at the `model busy` wait.
const GEMINI = 'https://generativelanguage.googleapis.com/';
const INTERACTIONS = `${GEMINI}v1beta/interactions`;
const realFetch = globalThis.fetch;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(GEMINI)) return realFetch(input, init);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (method !== 'POST' || url !== INTERACTIONS) {
    throw new Error(`Unhandled Gemini request in E2E: ${method} ${url}`);
  }
  return new Response(
    JSON.stringify({
      error: { code: 429, message: 'Resource exhausted.', status: 'RESOURCE_EXHAUSTED' },
    }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  );
};

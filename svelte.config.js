import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    // Runes for app code only; third-party components may still ship legacy syntax.
    runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
  },
  kit: {
    adapter: adapter(),
    // Lets tests under tests/ import route modules without deep relative paths.
    alias: { $routes: 'src/routes' },
    // Sentry initializes from src/instrumentation.server.ts, before any app module loads, and
    // SvelteKit's own server tracing feeds the same spans.
    experimental: { instrumentation: { server: true }, tracing: { server: true } },
  },
};

export default config;

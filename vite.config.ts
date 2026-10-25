import { sentrySvelteKit } from '@sentry/sveltekit/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const fake = (name: string) =>
  fileURLToPath(new URL(`tests/e2e/fakes/${name}.ts`, import.meta.url));

// E2E builds swap Google Cloud clients for in-memory fakes and the database for a PGlite seeded
// with fixture users and jobs; release and check builds never include them.
const e2eFakes = process.env.E2E_FAKES === '1';

// App modules can't be swapped by `resolve.alias`: `#lib` subpath imports resolve before it
// applies. Matching the resolved file catches every import of it. Window media is faked because
// E2E runs no ffmpeg.
const appFakes = new Map([
  [fileURLToPath(new URL('src/lib/server/core/db.ts', import.meta.url)), fake('db')],
  [fileURLToPath(new URL('src/lib/server/media/window.ts', import.meta.url)), fake('window')],
]);
const e2eModules: Plugin = {
  name: 'e2e-modules',
  enforce: 'pre',
  async resolveId(id, importer) {
    const resolved = await this.resolve(id, importer, { skipSelf: true });
    return (resolved && appFakes.get(resolved.id)) ?? null;
  },
};

export default defineConfig({
  plugins: [
    sentrySvelteKit({
      org: 'anchildress1dev',
      project: 'soundboard',
      // Only release builds upload source maps; local check builds would flood Sentry with releases.
      autoUploadSourceMaps: process.env.SENTRY_UPLOAD_SOURCEMAPS === 'true',
      // The image build has no .git to name the release from, so deploy.sh passes the commit.
      release: { name: process.env.SENTRY_RELEASE || undefined },
      telemetry: false,
    }),
    sveltekit({
      compilerOptions: {
        // Runes for app code only; third-party components may still ship legacy syntax.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },
      adapter: adapter(),
      // Sentry initializes from src/instrumentation.server.ts, before any app module loads, and
      // SvelteKit's own server tracing feeds the same spans.
      tracing: { server: true },
    }),
    ...(e2eFakes ? [e2eModules] : []),
  ],
  ssr: {
    // Sentry instruments these at build time, so they must be bundled; adapter-node externalizes
    // every other dependency before Sentry's own `noExternal` applies.
    noExternal: ['pg', 'ai'],
    // adapter-node bundles devDependencies, and a bundled PGlite can't find its .data and .wasm files.
    ...(e2eFakes && { external: ['@electric-sql/pglite'] }),
  },
  ...(e2eFakes && {
    resolve: {
      alias: {
        '@google-cloud/kms': fake('kms'),
        '@google-cloud/storage': fake('storage'),
      },
    },
  }),
});

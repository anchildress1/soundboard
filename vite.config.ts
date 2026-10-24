import { sentrySvelteKit } from '@sentry/sveltekit/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const fake = (name: string) =>
  fileURLToPath(new URL(`tests/e2e/fakes/${name}.ts`, import.meta.url));

// E2E builds swap Google Cloud clients for in-memory fakes and the database for a PGlite seeded
// with fixture users and jobs; release and check builds never include them.
const e2eFakes =
  process.env.E2E_FAKES === '1'
    ? {
        alias: {
          '@google-cloud/kms': fake('kms'),
          '@google-cloud/storage': fake('storage'),
        },
      }
    : undefined;

// App modules can't be swapped by `resolve.alias`: SvelteKit's `$lib` alias rewrites the specifier
// first. Matching the resolved file catches every import of it. Window media is faked because E2E
// runs no ffmpeg.
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
    sveltekit(),
    ...(e2eFakes ? [e2eModules] : []),
  ],
  resolve: e2eFakes,
});

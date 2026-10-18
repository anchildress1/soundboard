import { sentrySvelteKit } from '@sentry/sveltekit/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const fake = (name: string) =>
  fileURLToPath(new URL(`tests/e2e/fakes/${name}.ts`, import.meta.url));

// E2E builds swap Google Cloud clients for in-memory fakes seeded with fixture jobs; release and
// check builds never include them.
const e2eFakes =
  process.env.E2E_FAKES === '1'
    ? {
        alias: {
          '@google-cloud/firestore': fake('firestore'),
          '@google-cloud/kms': fake('kms'),
          '@google-cloud/storage': fake('storage'),
          '@google-cloud/secret-manager': fake('secret-manager'),
        },
      }
    : undefined;

// The app's database module can't be swapped by `resolve.alias`: SvelteKit's `$lib` alias rewrites
// the specifier first. Matching the resolved file catches every import of it.
const dbModule = fileURLToPath(new URL('src/lib/server/core/db.ts', import.meta.url));
const e2eDb: Plugin = {
  name: 'e2e-db',
  enforce: 'pre',
  async resolveId(id, importer) {
    const resolved = await this.resolve(id, importer, { skipSelf: true });
    return resolved?.id === dbModule ? fake('db') : null;
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
    ...(e2eFakes ? [e2eDb] : []),
  ],
  resolve: e2eFakes,
});

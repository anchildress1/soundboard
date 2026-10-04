import { sentrySvelteKit } from '@sentry/sveltekit/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fake = (name: string) =>
  fileURLToPath(new URL(`tests/e2e/fakes/${name}.ts`, import.meta.url));

// E2E builds swap Google Cloud clients for in-memory fakes seeded with fixture jobs; release and
// check builds never include them.
const e2eFakes =
  process.env.E2E_FAKES === '1'
    ? {
        alias: {
          '@google-cloud/firestore': fake('firestore'),
          '@google-cloud/storage': fake('storage'),
          '@google-cloud/secret-manager': fake('secret-manager'),
        },
      }
    : undefined;

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
  ],
  resolve: e2eFakes,
});

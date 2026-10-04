import { sentrySvelteKit } from '@sentry/sveltekit/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

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
});

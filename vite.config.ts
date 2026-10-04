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
      telemetry: false,
    }),
    sveltekit(),
  ],
});

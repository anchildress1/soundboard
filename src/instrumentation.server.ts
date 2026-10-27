import { init } from '@sentry/sveltekit';
import { scrubBreadcrumb, scrubEvent, scrubSpan } from '#lib/scrub.js';

init({
  dsn: process.env.PUBLIC_SENTRY_DSN,
  // Without it every event, local dev included, reports as production.
  environment: import.meta.env.MODE,
  // Every job is one complete trace, upload through verify.
  tracesSampleRate: 1,
  beforeBreadcrumb: scrubBreadcrumb,
  beforeSend: scrubEvent,
  // scrubSpan only runs while spans stream; a static lifecycle would skip it and send them raw.
  traceLifecycle: 'stream',
  beforeSendSpan: scrubSpan,
});

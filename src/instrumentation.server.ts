import * as Sentry from '@sentry/sveltekit';
import { scrubBreadcrumb, scrubEvent, scrubSpan } from '$lib/scrub';

Sentry.init({
  dsn: process.env.PUBLIC_SENTRY_DSN,
  // Every job is one complete trace, upload through verify.
  tracesSampleRate: 1,
  beforeBreadcrumb: scrubBreadcrumb,
  beforeSend: scrubEvent,
  // scrubSpan only runs while spans stream; a static lifecycle would skip it and send them raw.
  traceLifecycle: 'stream',
  beforeSendSpan: scrubSpan,
});

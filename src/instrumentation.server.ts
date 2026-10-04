import * as Sentry from '@sentry/sveltekit';
import { scrubBreadcrumb, scrubEvent } from '$lib/scrub';

Sentry.init({
  dsn: process.env.PUBLIC_SENTRY_DSN,
  // Every job is one complete trace, upload through verify.
  tracesSampleRate: 1.0,
  beforeBreadcrumb: scrubBreadcrumb,
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
});

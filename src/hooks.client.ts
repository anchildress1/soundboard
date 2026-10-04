import * as Sentry from '@sentry/sveltekit';
import { env } from '$env/dynamic/public';
import { scrubBreadcrumb, scrubEvent, scrubSpan } from '$lib/scrub';

Sentry.init({
  dsn: env.PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1,
  integrations: [Sentry.browserTracingIntegration()],
  beforeBreadcrumb: scrubBreadcrumb,
  beforeSend: scrubEvent,
  beforeSendSpan: scrubSpan,
});

export const handleError = Sentry.handleErrorWithSentry();

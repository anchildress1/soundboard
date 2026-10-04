import * as Sentry from '@sentry/sveltekit';
import { env } from '$env/dynamic/public';
import { scrubBreadcrumb, scrubEvent } from '$lib/scrub';

Sentry.init({
  dsn: env.PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1,
  integrations: [Sentry.browserTracingIntegration()],
  beforeBreadcrumb: scrubBreadcrumb,
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
});

export const handleError = Sentry.handleErrorWithSentry();

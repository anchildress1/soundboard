import { browserTracingIntegration, handleErrorWithSentry, init } from '@sentry/sveltekit';
import { env } from '$env/dynamic/public';
import { scrubBreadcrumb, scrubEvent, scrubSpan } from '$lib/scrub';

init({
  dsn: env.PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1,
  integrations: [browserTracingIntegration()],
  beforeBreadcrumb: scrubBreadcrumb,
  beforeSend: scrubEvent,
  // scrubSpan only runs while spans stream; a static lifecycle would skip it and send them raw.
  traceLifecycle: 'stream',
  beforeSendSpan: scrubSpan,
});

export const handleError = handleErrorWithSentry();

import { browserTracingIntegration, handleErrorWithSentry, init } from '@sentry/sveltekit';
import { PUBLIC_SENTRY_DSN } from '$app/env/public';
import { scrubBreadcrumb, scrubEvent, scrubSpan } from '#lib/scrub.js';

init({
  dsn: PUBLIC_SENTRY_DSN,
  // Without it every event, local dev included, reports as production.
  environment: import.meta.env.MODE,
  tracesSampleRate: 1,
  integrations: [browserTracingIntegration()],
  beforeBreadcrumb: scrubBreadcrumb,
  beforeSend: scrubEvent,
  // scrubSpan only runs while spans stream; a static lifecycle would skip it and send them raw.
  traceLifecycle: 'stream',
  beforeSendSpan: scrubSpan,
});

export const handleError = handleErrorWithSentry();

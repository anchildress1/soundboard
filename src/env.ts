import { defineEnvVars } from '@sveltejs/kit/env';

// Read at runtime. Unset in local dev and E2E, where an empty DSN keeps Sentry off.
export const variables = defineEnvVars({
  PUBLIC_SENTRY_DSN: { public: true, schema: (input) => input ?? '' },
});

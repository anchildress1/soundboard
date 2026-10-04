import type { Handle, HandleServerError } from '@sveltejs/kit';
import { vi } from 'vitest';

/**
 * Stand-in for `@sentry/sveltekit`, registered for every test in vitest-setup.ts. The real SDK
 * starts OpenTelemetry context managers and global state; tests only need to see what the app asks
 * Sentry to do.
 */
export const span = { setAttribute: vi.fn(), setAttributes: vi.fn() };

export const init = vi.fn();
export const startSpan = vi.fn((_options: unknown, fn: (s: typeof span) => unknown) => fn(span));
export const startNewTrace = vi.fn((fn: () => unknown) => fn());
export const getTraceData = vi.fn((): Record<string, string> => ({}));
export const captureException = vi.fn();
export const captureMessage = vi.fn();
export const browserTracingIntegration = vi.fn(() => ({ name: 'BrowserTracing' }));
export const sentryHandle = vi.fn(
  (): Handle =>
    ({ event, resolve }) =>
      resolve(event),
);
export const handleErrorWithSentry = vi.fn((): HandleServerError => () => undefined);

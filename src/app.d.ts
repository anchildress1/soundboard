import type { Session } from '$lib/server/auth';

declare global {
  namespace App {
    interface Locals {
      session: Session | null;
      /** Set by the job page so its HTML carries the job's trace instead of the request's. */
      jobTrace?: { sentryTrace: string; baggage: string } | null;
    }
  }
}

export {};

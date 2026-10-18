declare global {
  namespace App {
    interface Locals {
      /** The signed-in user, resolved by the gate in hooks.server.ts; null when signed out. */
      user: { uid: string; email: string; artistId: string | null } | null;
      /** Set by the job page so its HTML carries the job's trace instead of the request's. */
      jobTrace?: { sentryTrace: string; baggage: string } | null;
    }
  }
}

export {};

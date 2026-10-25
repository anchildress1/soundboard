import type { ArtistProfile } from '#lib/server/artist/profile.js';

declare global {
  namespace App {
    interface Locals {
      /** The signed-in user, resolved by the session hook; null when signed out. */
      user: { uid: string; sid: string; email: string; artist: ArtistProfile | null } | null;
      /** Set by the job page so its HTML carries the job's trace instead of the request's. */
      jobTrace?: { sentryTrace: string; baggage: string } | null;
    }
  }
}

export {};

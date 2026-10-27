// The artist's own results as a pick reads them (research R8): fresh, shared, newest upload first,
// each linked to what was suggested and what was published.
import { desc } from 'drizzle-orm';
import type { Calculated, PickFields } from '#lib/types.js';
import { publishesFor } from '#lib/server/artist/memory.js';
import { query } from '#lib/server/core/db.js';
import { artistOutcomes } from '#lib/server/core/schema.js';
import { netSubscribers } from './calculated';

/** Outcomes a pick can cite; the table holds at most the 20 uploads the learn stage reports. */
export const OUTCOMES_IN_PICK = 10;

/** One of the artist's own uploads with its results, what was suggested and what was published. */
export type PickOutcome = {
  ref: string;
  videoId: string;
  suggested: { approach: string; intendedOutcome: string } | null;
  published: PickFields | null;
  editedBeforeApproval: boolean | null;
  differsFromApproved: boolean | null;
  coverage: 'open' | 'complete' | 'unknown';
  window: { start: string; end: string };
  metrics: {
    views: number | null;
    subscribersGained: number | null;
    subscribersLost: number | null;
  };
  net: Calculated;
  live: { title: string; description: string; tags: string[] };
};

/**
 * The artist's fresh outcomes as `A1…`. RLS shows only their own rows, and only while analytics is
 * shared and the row is fresh, so a revoked grant or an expired row simply isn't here.
 */
export async function pickOutcomes(artistId: string): Promise<PickOutcome[]> {
  const rows = await query((tx) =>
    tx
      .select()
      .from(artistOutcomes)
      .orderBy(desc(artistOutcomes.publishedAt))
      .limit(OUTCOMES_IN_PICK),
  );
  const publishes = new Map(
    (
      await publishesFor(
        artistId,
        rows.map((row) => row.videoId),
      )
    ).map((publish) => [publish.videoId, publish]),
  );
  return rows.map((row, index) => {
    const publish = publishes.get(row.videoId);
    const metrics = row.metrics as PickOutcome['metrics'];
    return {
      ref: `A${index + 1}`,
      videoId: row.videoId,
      suggested: publish?.recommendation
        ? {
            approach: publish.recommendation.approach,
            intendedOutcome: publish.recommendation.intendedOutcome,
          }
        : null,
      published: publish?.fields ?? null,
      editedBeforeApproval: publish?.editedBeforeApproval ?? null,
      differsFromApproved: row.differsFromApproved,
      coverage: row.coverage,
      window: { start: row.requestedStart, end: row.requestedEnd },
      metrics,
      net: netSubscribers(metrics),
      live: row.live as PickOutcome['live'],
    };
  });
}

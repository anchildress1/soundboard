// Stands in for src/lib/server/research/queue.ts in the E2E build, which has no Cloud Tasks: the
// first delivery finishes the run as if research found nothing, so the pick's next poll proceeds.
// Specs that need evidence seed a finished run and its evidence in fixtures.ts instead.
import { eq, sql } from 'drizzle-orm';
import { query } from '#lib/server/core/db.js';
import { researchRuns } from '#lib/server/core/schema.js';
import type { Delivery } from '#lib/server/research/runs.js';

export async function enqueue(delivery: Delivery): Promise<void> {
  await query((tx) =>
    tx
      .update(researchRuns)
      .set({
        stage: 'done',
        limits: ['analytics-not-shared', 'no-peers'],
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(researchRuns.id, delivery.runId)),
  );
}

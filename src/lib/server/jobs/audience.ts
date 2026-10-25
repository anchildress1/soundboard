import { eq, sql } from 'drizzle-orm';
import { query, type Database, type Tx } from '#lib/server/core/db.js';
import { jobAudience, jobAudienceFresh } from '#lib/server/core/schema.js';
import type { AudienceEvidence } from '#lib/server/pipeline/hashtags.js';

/** The database clock excludes expired research even before scheduled deletion runs. */
export async function readAudience(
  id: string,
  q?: Database | Tx,
): Promise<AudienceEvidence | null> {
  if (!q) return query((tx) => readAudience(id, tx));
  const [row] = await q
    .select({ evidence: jobAudienceFresh.evidence })
    .from(jobAudienceFresh)
    .where(eq(jobAudienceFresh.jobId, id));
  return row?.evidence ?? null;
}

/** Persists research with its original retrieval time, including on retries and Shorts. */
export async function saveAudience(tx: Tx, id: string, evidence: AudienceEvidence): Promise<void> {
  if (!Number.isFinite(evidence.retrievedAt)) throw new Error('Missing research retrieval time.');
  // The function can replace expired evidence without making expired rows readable to the app.
  await tx.execute(sql`select public.soundboard_save_audience(${id},
    ${new Date(evidence.retrievedAt).toISOString()}::timestamptz, ${JSON.stringify(evidence)}::jsonb)`);
}

/** Removes expired research without touching jobs or the artist's own drafts. */
export async function deleteExpiredAudience(q?: Database | Tx): Promise<number> {
  if (!q) return query((tx) => deleteExpiredAudience(tx));
  const deleted = await q
    .delete(jobAudience)
    .where(sql`${jobAudience.retrievedAt} <= now() - interval '30 days'`)
    .returning({ id: jobAudience.jobId });
  return deleted.length;
}

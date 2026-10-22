import { gt, sql } from 'drizzle-orm';
import { db, type Database, type Tx } from '$lib/server/core/db';
import { jobAudience } from '$lib/server/core/schema';
import type { AudienceEvidence } from '$lib/server/pipeline/hashtags';

/** The database clock excludes expired research even before scheduled deletion runs. */
export async function readAudience(
  id: string,
  q: Database | Tx = db(),
): Promise<AudienceEvidence | null> {
  const [row] = await q
    .select({ evidence: jobAudience.evidence })
    .from(jobAudience)
    .where(
      sql`${jobAudience.jobId} = ${id} and ${jobAudience.retrievedAt} > now() - interval '30 days'`,
    );
  return row?.evidence ?? null;
}

/** Persists research with its original retrieval time, including on retries and Shorts. */
export async function saveAudience(tx: Tx, id: string, evidence: AudienceEvidence): Promise<void> {
  if (!Number.isFinite(evidence.retrievedAt)) throw new Error('Missing research retrieval time.');
  await tx
    .insert(jobAudience)
    .values({ jobId: id, retrievedAt: new Date(evidence.retrievedAt), evidence })
    .onConflictDoUpdate({
      target: jobAudience.jobId,
      set: { retrievedAt: new Date(evidence.retrievedAt), evidence },
      setWhere: gt(sql`excluded.retrieved_at`, jobAudience.retrievedAt),
    });
}

/** Removes expired research without touching jobs or the artist's own drafts. */
export async function deleteExpiredAudience(q: Database | Tx = db()): Promise<number> {
  const deleted = await q
    .delete(jobAudience)
    .where(sql`${jobAudience.retrievedAt} <= now() - interval '30 days'`)
    .returning({ id: jobAudience.jobId });
  return deleted.length;
}

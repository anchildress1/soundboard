import { and, desc, eq, sql } from 'drizzle-orm';
import type { PickFields } from '#lib/types.js';
import { query, type Database, type Tx } from '#lib/server/core/db.js';
import { artistMemory, jobs, users } from '#lib/server/core/schema.js';

/** One artist's memory rows of one kind. */
export const memoryOf = (artistId: string, kind: (typeof artistMemory.kind.enumValues)[number]) =>
  and(eq(artistMemory.artistId, artistId), eq(artistMemory.kind, kind));

export type FactKind = 'FACT' | 'INFERENCE' | 'APPROVED';
export type Fact = { key: string; value: string; kind: FactKind; public: boolean };

export type FeedbackKind = 'EDITED' | 'SKIPPED' | 'ACCEPTED';
export type Feedback = {
  kind: FeedbackKind;
  jobId: string;
  songTitle: string;
  pickVersion: number;
  field?: keyof PickFields;
  before?: string;
  after?: string;
  at: number;
};

/**
 * Whether a job may use its artist's memory: the job was created under an artist and its owner is
 * still linked to that artist now, so unlinking a user cuts off their open jobs too. Pass the
 * transaction that writes the feedback, so the link is read where it is used.
 */
export async function artistJob(
  job: { ownerUid: string; artistId: string | null },
  q?: Database | Tx,
): Promise<boolean> {
  if (job.artistId === null) return false;
  if (!q) return await query((tx) => artistJob(job, tx));
  const [owner] = await q
    .select({ artistId: users.artistId })
    .from(users)
    .where(eq(users.uid, job.ownerUid));
  return owner?.artistId === job.artistId;
}

/**
 * The artist's facts: the name, always derived from the profile (FR-014), then the stored facts
 * when the job may use the artist's memory.
 */
export async function listFacts(
  artist: { id: string; name: string },
  memory: boolean,
): Promise<Fact[]> {
  const name: Fact = { key: 'artist-name', value: artist.name, kind: 'FACT', public: true };
  if (!memory) return [name];
  const rows = await query((tx) =>
    tx.select({ data: artistMemory.data }).from(artistMemory).where(memoryOf(artist.id, 'fact')),
  );
  return [name, ...rows.map((r) => r.data as Fact)];
}

/**
 * Writes feedback rows in the caller's transaction, so they commit with the state change they
 * describe. Feedback on an artist job (`artistJob`) goes to the artist; any other stays on the job.
 */
export async function writeFeedback(
  tx: Tx,
  entries: Feedback[],
  job: { id: string; ownerUid: string; artistId: string | null },
): Promise<void> {
  if (entries.length === 0) return;
  if (job.artistId !== null && (await artistJob(job, tx))) {
    const { artistId } = job;
    await tx
      .insert(artistMemory)
      .values(entries.map((data) => ({ artistId, kind: 'feedback' as const, data })));
  } else {
    const kept = await tx
      .update(jobs)
      .set({ feedback: sql`${jobs.feedback} || ${JSON.stringify(entries)}::jsonb` })
      .where(eq(jobs.id, job.id))
      .returning({ id: jobs.id });
    if (kept.length === 0) throw new Error(`No job ${job.id} to keep feedback on`);
  }
}

/** The artist's latest feedback, newest first. */
export async function recentFeedback(artistId: string, limit = 20): Promise<Feedback[]> {
  const rows = await query((tx) =>
    tx
      .select({ data: artistMemory.data })
      .from(artistMemory)
      .where(memoryOf(artistId, 'feedback'))
      .orderBy(desc(artistMemory.id))
      .limit(limit),
  );
  return rows.map((r) => r.data as Feedback);
}

export async function recordPublish(
  tx: Tx,
  artistId: string,
  record: {
    videoId: string;
    url: string;
    jobId: string;
    fields: PickFields;
    status: 'VERIFIED';
    at: number;
  },
): Promise<void> {
  await tx
    .insert(artistMemory)
    .values({ artistId, kind: 'publish', key: record.videoId, data: record })
    .onConflictDoUpdate({
      target: [artistMemory.artistId, artistMemory.kind, artistMemory.key],
      set: { data: record },
    });
}

const asText = (v: string | string[]) => (Array.isArray(v) ? v.join(', ') : v);

/** Feedback rows for one approval: an EDITED row per changed field, then the ACCEPTED row. */
export function approvalFeedback(
  proposed: PickFields,
  final: PickFields,
  meta: { jobId: string; songTitle: string; pickVersion: number; at: number },
): Feedback[] {
  const rows: Feedback[] = [];
  for (const field of ['title', 'description', 'tags'] as const) {
    const before = asText(proposed[field]);
    const after = asText(final[field]);
    if (before !== after) rows.push({ kind: 'EDITED', field, before, after, ...meta });
  }
  rows.push({ kind: 'ACCEPTED', ...meta, after: final.title });
  return rows;
}

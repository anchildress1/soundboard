import { and, desc, eq, sql } from 'drizzle-orm';
import type { PickFields } from '$lib/types';
import { db, type Database, type Tx } from '$lib/server/core/db';
import { artistMemory, jobs, users } from '$lib/server/core/schema';

export const ARTIST_ID = 'flr';
export const ARTIST_NAME = 'Flies Like Robots';

/** The artist's memory rows of one kind. */
export const memoryOf = (kind: (typeof artistMemory.kind.enumValues)[number]) =>
  and(eq(artistMemory.artistId, ARTIST_ID), eq(artistMemory.kind, kind));

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

/** Seeded once. The INFERENCE stays out of public copy until Nathan confirms it. */
export const SEED_FACTS: Fact[] = [
  { key: 'artist-name', value: ARTIST_NAME, kind: 'FACT', public: true },
  { key: 'home', value: 'Virginia', kind: 'FACT', public: true },
  { key: 'mr-kill', value: 'Connected to the artist Mr. Kill', kind: 'INFERENCE', public: false },
];

/**
 * Whether a job may use the artist's identity and memory: the job was created under the artist and
 * its owner is still linked now, so unlinking a user cuts off their open jobs too. Pass the
 * transaction that writes the feedback, so the link is read where it is used.
 */
export async function artistJob(
  job: { ownerUid: string; artistId: string | null },
  q: Database | Tx = db(),
): Promise<boolean> {
  if (job.artistId !== ARTIST_ID) return false;
  const [owner] = await q
    .select({ artistId: users.artistId })
    .from(users)
    .where(eq(users.uid, job.ownerUid));
  return owner?.artistId === ARTIST_ID;
}

/** Reads Nathan's facts, seeding an empty table on first use. Call only on artist jobs. */
export async function listFacts(): Promise<Fact[]> {
  const rows = await db()
    .select({ data: artistMemory.data })
    .from(artistMemory)
    .where(memoryOf('fact'));
  if (rows.length > 0) return rows.map((r) => r.data as Fact);
  await db()
    .insert(artistMemory)
    .values(
      SEED_FACTS.map((fact) => ({
        artistId: ARTIST_ID,
        kind: 'fact' as const,
        key: fact.key,
        data: fact,
      })),
    )
    .onConflictDoNothing();
  return SEED_FACTS;
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
  if (await artistJob(job, tx)) {
    await tx
      .insert(artistMemory)
      .values(entries.map((data) => ({ artistId: ARTIST_ID, kind: 'feedback' as const, data })));
  } else {
    const kept = await tx
      .update(jobs)
      .set({ feedback: sql`${jobs.feedback} || ${JSON.stringify(entries)}::jsonb` })
      .where(eq(jobs.id, job.id))
      .returning({ id: jobs.id });
    if (kept.length === 0) throw new Error(`No job ${job.id} to keep feedback on`);
  }
}

/** Nathan's latest feedback, newest first. */
export async function recentFeedback(limit = 20): Promise<Feedback[]> {
  const rows = await db()
    .select({ data: artistMemory.data })
    .from(artistMemory)
    .where(memoryOf('feedback'))
    .orderBy(desc(artistMemory.id))
    .limit(limit);
  return rows.map((r) => r.data as Feedback);
}

export async function recordPublish(
  tx: Tx,
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
    .values({ artistId: ARTIST_ID, kind: 'publish', key: record.videoId, data: record })
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

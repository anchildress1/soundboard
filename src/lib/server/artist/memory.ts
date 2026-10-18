import { desc, eq } from 'drizzle-orm';
import type { PickFields } from '$lib/types';
import { db, type Tx } from '$lib/server/core/db';
import { artistFacts, artistFeedback, artistPublishes, jobFeedback } from '$lib/server/core/schema';

export const ARTIST_ID = 'flr';
export const ARTIST_NAME = 'Flies Like Robots';

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

/** What a job outside the artist may know about them without reading the artist tables. */
export const PUBLIC_FACTS: Fact[] = [SEED_FACTS[0]!];

/**
 * Reads Nathan's facts. With `seed` (Nathan's own jobs only), an empty table is seeded on first
 * use; without it, the seeds are returned in memory and nothing is written.
 */
export async function listFacts({ seed }: { seed: boolean }): Promise<Fact[]> {
  const rows = await db()
    .select({ data: artistFacts.data })
    .from(artistFacts)
    .where(eq(artistFacts.artistId, ARTIST_ID));
  if (rows.length > 0) return rows.map((r) => r.data as Fact);
  if (seed) {
    await db()
      .insert(artistFacts)
      .values(SEED_FACTS.map((fact) => ({ artistId: ARTIST_ID, key: fact.key, data: fact })))
      .onConflictDoNothing();
  }
  return SEED_FACTS;
}

/**
 * Writes feedback rows in the caller's transaction, so they commit with the state change they
 * describe. Feedback on the artist's jobs goes to the artist; any other job's stays on that job.
 */
export async function writeFeedback(
  tx: Tx,
  entries: Feedback[],
  target: { toArtist: boolean; jobId: string },
): Promise<void> {
  if (entries.length === 0) return;
  if (target.toArtist) {
    await tx
      .insert(artistFeedback)
      .values(entries.map((data) => ({ artistId: ARTIST_ID, at: new Date(data.at), data })));
  } else {
    await tx.insert(jobFeedback).values(entries.map((data) => ({ jobId: target.jobId, data })));
  }
}

/** Nathan's latest feedback, newest first. */
export async function recentFeedback(limit = 20): Promise<Feedback[]> {
  const rows = await db()
    .select({ data: artistFeedback.data })
    .from(artistFeedback)
    .where(eq(artistFeedback.artistId, ARTIST_ID))
    .orderBy(desc(artistFeedback.at))
    .limit(limit);
  return rows.map((r) => r.data as Feedback);
}

export async function recordPublish(record: {
  videoId: string;
  url: string;
  jobId: string;
  fields: PickFields;
  status: 'VERIFIED';
  at: number;
}): Promise<void> {
  await db()
    .insert(artistPublishes)
    .values({ artistId: ARTIST_ID, videoId: record.videoId, data: record })
    .onConflictDoUpdate({
      target: [artistPublishes.artistId, artistPublishes.videoId],
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

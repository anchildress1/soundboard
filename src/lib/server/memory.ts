import type { Transaction } from '@google-cloud/firestore';
import type { PickFields } from '$lib/types';
import { db } from './clients';

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

/** What a visitor job may know about the artist without reading `artists/*`. */
export const PUBLIC_FACTS: Fact[] = [SEED_FACTS[0]!];

const artist = () => db().collection('artists').doc(ARTIST_ID);

/** Allowlisted callers only: reads Nathan's facts, seeding them on first use. */
export async function listFacts(): Promise<Fact[]> {
  const col = artist().collection('facts');
  const snap = await col.get();
  if (!snap.empty) return snap.docs.map((d) => d.data() as Fact);
  await Promise.all(SEED_FACTS.map((fact) => col.doc(fact.key).set(fact)));
  return SEED_FACTS;
}

/**
 * Queues feedback rows in the caller's transaction, so they commit with the state change they
 * describe. Allowlisted feedback goes to the artist; visitor feedback stays on its job.
 */
export function writeFeedback(
  tx: Transaction,
  entries: Feedback[],
  target: { allowlisted: boolean; jobId: string },
): void {
  const col = target.allowlisted
    ? artist().collection('feedback')
    : db().collection('jobs').doc(target.jobId).collection('feedback');
  for (const entry of entries) tx.set(col.doc(), entry);
}

/** Allowlisted callers only: Nathan's latest feedback, newest first. */
export async function recentFeedback(limit = 20): Promise<Feedback[]> {
  const snap = await artist().collection('feedback').orderBy('at', 'desc').limit(limit).get();
  return snap.docs.map((d) => d.data() as Feedback);
}

export async function recordPublish(record: {
  videoId: string;
  url: string;
  jobId: string;
  fields: PickFields;
  status: 'VERIFIED';
  at: number;
}): Promise<void> {
  await artist().collection('publishes').doc(record.videoId).set(record);
}

/** Feedback rows for one approval: an EDITED row per changed field, then the ACCEPTED row. */
export function approvalFeedback(
  proposed: PickFields,
  final: PickFields,
  meta: { jobId: string; songTitle: string; pickVersion: number; at: number },
): Feedback[] {
  const rows: Feedback[] = [];
  const asText = (v: string | string[]) => (Array.isArray(v) ? v.join(', ') : v);
  for (const field of ['title', 'description', 'tags'] as const) {
    const before = asText(proposed[field]);
    const after = asText(final[field]);
    if (before !== after) rows.push({ kind: 'EDITED', field, before, after, ...meta });
  }
  rows.push({ kind: 'ACCEPTED', ...meta, after: final.title });
  return rows;
}

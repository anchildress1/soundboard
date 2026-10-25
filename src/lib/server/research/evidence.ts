// Peer evidence per research run (data-model `job_research`): Non-Authorized YouTube data, hidden
// after 29 days and written only under the run's claim.
import { eq, sql } from 'drizzle-orm';
import { query, type Tx } from '#lib/server/core/db.js';
import { jobResearch } from '#lib/server/core/schema.js';
import type { ChannelStatsReported } from '#lib/server/platforms/youtube/index.js';
import type { Bracket, Relation } from './brackets';

export type { Bracket, ChannelStatsReported };

/** The newest upload of a candidate's channel, heard or read when matching. */
export type Sample = { videoId: string; title: string; tags: string[] };

/** A channel found by the genre search that may become a peer. */
export type Candidate = {
  channelId: string;
  title: string;
  description: string;
  uploadsPlaylist: string | null;
  stats: ChannelStatsReported;
  bracket: Bracket | null;
  relation: Relation | null;
  /** Null once read when the channel has no public upload. */
  sample?: Sample | null;
  /** Set once matched; `kept` only for an artist whose sound is the same. */
  match?: { kept: boolean; basis: Basis; explanation: string };
};

export type Basis = 'heard' | 'metadata-only';

export type Peer = {
  ref: string;
  channelId: string;
  title: string;
  basis: Basis;
  explanation: string;
  stats: ChannelStatsReported;
  bracket: Bracket | null;
  relation: Relation | null;
  /** A two-up peer: it may support a recommendation, never carry it alone. */
  secondary: boolean;
};

export type SelectedAs = 'newest' | 'most-viewed' | 'most-engaged';

/** One of a peer's own releases, with its statistics as reported. */
export type PeerRelease = {
  ref: string;
  peer: string;
  videoId: string;
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  durationSec: number;
  publishedAt: string;
  stats: { views: number | null; likes: number | null; comments: number | null };
  selectedAs: SelectedAs;
};

export type PeerEvidence = {
  query: string;
  artist: { stats: ChannelStatsReported | null; bracket: Bracket | null };
  candidates: Candidate[];
  peers: Peer[];
  releases: PeerRelease[];
  skipped: { channelId: string; reason: string }[];
};

export type StoredEvidence = { retrievedAt: Date; evidence: PeerEvidence };

/**
 * Saves the run's evidence under its live claim. The first save's time stays the retrieval time,
 * so a later batch never extends the evidence's life.
 */
export async function saveEvidence(
  tx: Tx,
  runId: string,
  token: string,
  evidence: PeerEvidence,
): Promise<void> {
  await tx.execute(
    sql`select public.soundboard_save_research(${runId}, ${token}, now(), ${JSON.stringify(evidence)}::jsonb)`,
  );
}

/** The run's evidence while fresh, else null; only the job's owner sees it. */
export async function readEvidence(runId: string): Promise<StoredEvidence | null> {
  const [row] = await query((tx) =>
    tx.select().from(jobResearch).where(eq(jobResearch.runId, runId)),
  );
  return row ? { retrievedAt: row.retrievedAt, evidence: row.evidence as PeerEvidence } : null;
}

/** When evidence retrieved at `retrievedAt` is hidden: 29 days on. */
export const evidenceExpiry = (retrievedAt: Date) =>
  new Date(retrievedAt.getTime() + 29 * 24 * 60 * 60_000).toISOString();

export type Resolved =
  | { ref: string; peer: Peer }
  | { ref: string; release: PeerRelease; peer: Peer | null }
  | { ref: string; expired: true; expiresAt: string | null };

/**
 * A pick's `P<n>` or `P<n>-R<m>` ref against its own run's evidence. Gone or unknown resolves as
 * expired, with the date the pick recorded.
 */
export function resolveRef(
  evidence: PeerEvidence | null,
  ref: string,
  expiresAt: string | null,
): Resolved {
  const release = evidence?.releases.find((r) => r.ref === ref);
  if (release) {
    return { ref, release, peer: evidence!.peers.find((p) => p.ref === release.peer) ?? null };
  }
  const peer = evidence?.peers.find((p) => p.ref === ref);
  return peer ? { ref, peer } : { ref, expired: true, expiresAt };
}

import { error } from '@sveltejs/kit';
import { inArray } from 'drizzle-orm';
import {
  FIELD_ROLES,
  sourceLabel,
  type Citation,
  type FieldName,
  type ReviewData,
  type ReviewPeer,
  type ReviewResult,
} from '#lib/review.js';
import type { JobState, JobView, Pick, Wait } from '#lib/types.js';
import { modelRole } from '#lib/status.js';
import { query } from '#lib/server/core/db.js';
import { analystModel, pickModel } from '#lib/server/core/env.js';
import { artistOutcomes } from '#lib/server/core/schema.js';
import { objectInfo, signedReadUrl } from '#lib/server/media/gcs.js';
import { nextBracket } from '#lib/server/research/brackets.js';
import { engagementRate, netSubscribers } from '#lib/server/research/calculated.js';
import {
  readEvidence,
  rejectedChannels,
  resolveRef,
  withoutRejected,
  type PeerEvidence,
} from '#lib/server/research/evidence.js';
import { getJob, latestPick, listChunks, toPublic, type JobDoc } from './jobs';

/** Loads the caller's own job; anyone else's, or any job when signed out, reads as missing. */
export async function authorizedJob(id: string, uid: string | undefined): Promise<JobDoc> {
  if (!uid) error(404, 'Job not found');
  const job = await getJob(id);
  if (job?.ownerUid !== uid) error(404, 'Job not found');
  return job;
}

/** States whose remaining work reads the job's media: everything but waiting, read-back and done. */
const NEEDS_MEDIA: ReadonlySet<JobState> = new Set([
  'PREP',
  'ANALYZE',
  'PICK',
  'HOOK',
  'RENDER',
  'REVIEW',
  'PUBLISHING',
]);

/** The object the job's remaining work reads, or null when it needs none. */
function neededMedia(job: JobDoc): string | null {
  // A failed job's remaining work is the step it failed at; retry falls back to PREP.
  const state = job.state === 'FAILED' ? (job.failedState ?? 'PREP') : job.state;
  if (!NEEDS_MEDIA.has(state)) return null;
  // A Short cuts from its video's object; its own object is the render it reviews and uploads.
  if (job.short && (state === 'HOOK' || state === 'RENDER')) return job.sourceObject;
  return job.object;
}

/** Whether the bucket's 7-day lifecycle already deleted media the job's remaining work needs. */
export async function mediaExpired(job: JobDoc): Promise<boolean> {
  const object = neededMedia(job);
  return object !== null && (await objectInfo(object)) === null;
}

/** States in which a Short's rendered object is the one on screen. */
const RENDERED: ReadonlySet<JobState> = new Set([
  'REVIEW',
  'PUBLISHING',
  'CLAIMED_COMPLETE',
  'VERIFIED',
]);

/** Signed playback of a Short's render, or null before it renders or once storage dropped it. */
async function playback(job: JobDoc): Promise<string | null> {
  if (!job.short?.renders || !RENDERED.has(job.state)) return null;
  return (await objectInfo(job.object)) ? signedReadUrl(job.object) : null;
}

export async function buildView(job: JobDoc, wait?: Wait): Promise<JobView> {
  const [chunks, stored, playbackUrl] = await Promise.all([
    listChunks(job.id),
    latestPick(job.id),
    playback(job),
  ]);
  // `skipped` rides along; the browser ignores it.
  const pick: Pick | null = stored;
  return {
    job: toPublic(job),
    chunks,
    pick,
    model: modelRole(job) === 'analyst' ? analystModel() : pickModel(),
    ...(wait ? { wait } : {}),
    ...(playbackUrl ? { playbackUrl } : {}),
  };
}

type OutcomeRow = typeof artistOutcomes.$inferSelect;
type Metrics = ReviewResult['metrics'];

/** The artist's fresh, shared results for the video IDs a pick cited; RLS drops the rest. */
async function outcomesOf(videoIds: string[]): Promise<Map<string, OutcomeRow>> {
  if (videoIds.length === 0) return new Map();
  const rows = await query((tx) =>
    tx.select().from(artistOutcomes).where(inArray(artistOutcomes.videoId, videoIds)),
  );
  return new Map(rows.map((row) => [row.videoId, row]));
}

/** One cited ref as the reader sees it: the source's name, or the note that it expired. */
export function resolveCitation(
  ref: string,
  pick: Pick,
  evidence: PeerEvidence | null,
  outcomes: Map<string, OutcomeRow>,
): Citation {
  if (/^A\d+$/.test(ref)) {
    const row = outcomes.get(pick.outcomeRefs?.[ref] ?? '');
    return row
      ? { ref, label: `Your result: ${(row.live as { title: string }).title}` }
      : { ref, expired: true, kind: 'result', expiresAt: null };
  }
  if (!/^P\d+(-R\d+)?$/.test(ref)) return { ref, label: sourceLabel(ref) };
  const found = resolveRef(evidence, ref, pick.evidenceExpiresAt ?? null);
  if ('expired' in found) return { ref, expired: true, kind: 'peer', expiresAt: found.expiresAt };
  return 'release' in found
    ? { ref, label: `${ref} · ${found.release.title}` }
    : { ref, label: `${ref} · ${found.peer.title}` };
}

const statsOf = (peer: PeerEvidence['peers'][number]): ReviewPeer['stats'] => ({
  subscribers: peer.stats.hidden ? 'hidden' : peer.stats.subscribers,
  videos: peer.stats.videos,
  views: peer.stats.views,
});

/** Peers in selection order, each with its own releases; nothing is totaled across them. */
function peersOf(evidence: PeerEvidence, retrievedAt: Date): ReviewPeer[] {
  return evidence.peers.map((peer) => ({
    ref: peer.ref,
    title: peer.title,
    basis: peer.basis,
    secondary: peer.secondary,
    explanation: peer.explanation,
    relation: peer.relation,
    stats: statsOf(peer),
    retrievedAt: retrievedAt.toISOString(),
    releases: evidence.releases
      .filter((release) => release.peer === peer.ref)
      .map((release) => ({
        ref: release.ref,
        title: release.title,
        url: `https://www.youtube.com/watch?v=${release.videoId}`,
        selectedAs: release.selectedAs,
        stats: release.stats,
        engagement: engagementRate(release.stats),
        publishedAt: release.publishedAt,
      })),
  }));
}

const resultOf = (ref: string, row: OutcomeRow): ReviewResult => {
  const metrics = row.metrics as Metrics;
  return {
    ref,
    title: (row.live as { title: string }).title,
    requested: { start: row.requestedStart, end: row.requestedEnd },
    coverage: row.coverage,
    metrics,
    net: netSubscribers(metrics),
  };
};

/**
 * What review shows about the pick's evidence, or null for a pick made before fanbase learning.
 * Peers come only from the pick's own run and only while fresh; the artist's rejected channels
 * are left out.
 */
export async function reviewData(pick: Pick | null): Promise<ReviewData | null> {
  if (!pick?.influence) return null;
  const refs = Object.entries(pick.outcomeRefs ?? {});
  const [stored, rejected, outcomes] = await Promise.all([
    pick.researchRunId ? readEvidence(pick.researchRunId) : null,
    rejectedChannels(),
    outcomesOf(refs.map(([, videoId]) => videoId)),
  ]);
  const evidence = stored ? withoutRejected(stored.evidence, rejected) : null;
  const cite = (ref: string) => resolveCitation(ref, pick, evidence, outcomes);
  const citations = pick.citations;
  const sources = Object.fromEntries(
    (Object.keys(FIELD_ROLES) as FieldName[]).map((field) => {
      const refsOf = FIELD_ROLES[field].flatMap((role) => citations?.[role] ?? []);
      return [field, [...new Set(refsOf)].map(cite)];
    }),
  ) as ReviewData['sources'];
  const current = evidence?.artist.bracket ?? null;
  return {
    version: pick.version,
    recommendation: pick.recommendation ?? null,
    evidence: (pick.recommendation?.evidence ?? []).map(cite),
    influence: pick.influence,
    influenceWarning: pick.influenceWarning ?? null,
    limits: pick.limits ?? pick.recommendation?.limits ?? [],
    ranges: current === null ? null : { current, target: nextBracket(current) },
    peers: stored && evidence ? peersOf(evidence, stored.retrievedAt) : null,
    evidenceExpiresAt: pick.evidenceExpiresAt ?? null,
    results: refs.flatMap(([ref, videoId]) => {
      const row = outcomes.get(videoId);
      return row ? [resultOf(ref, row)] : [];
    }),
    sources,
  };
}

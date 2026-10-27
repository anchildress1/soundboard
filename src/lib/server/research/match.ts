// Match (research R5): one `peer-match` call per candidate, in discover's order, keeps the artists
// whose sound is the same. Cursor k is the next candidate to judge.
import { matchPeer, songDigest, type SongDigest } from '#lib/server/ai/peer-match.js';
import { peerHearing } from '#lib/server/core/env.js';
import { listChunks } from '#lib/server/jobs/jobs.js';
import { eachItem, type Batch, type StageContext } from './batch';
import { MAX_PEERS, selectPeers } from './brackets';
import {
  readEvidence,
  saveEvidence,
  type Candidate,
  type Peer,
  type PeerEvidence,
} from './evidence';
import type { ResearchLimit } from './runs';

/** One call at about 4 s heard (G1), with room for a retry on the text alone. */
const MATCH_MS = 8_000;
const MIN_PEERS = 3;
const NO_UPLOAD = 'No public upload to compare.';

export async function match({ run, deadline }: StageContext): Promise<Batch> {
  const stored = await readEvidence(run.id);
  // Expired or deleted under a long run: nothing left to judge.
  if (!stored) return { done: 1, stage: 'done', cursor: 0, limits: ['no-peers'] };
  const { evidence } = stored;
  const digest = songDigest(await listChunks(run.jobId));
  const hearing = peerHearing();
  const items = await eachItem(evidence.candidates, run.cursor, deadline, MATCH_MS, async (c) => {
    c.match = await judge(c, digest, hearing, deadline);
    return nextRangeKept(evidence) >= MAX_PEERS ? 'stop' : undefined;
  });
  const writes: Batch['writes'] = (tx, token) => saveEvidence(tx, run.id, token, evidence);
  if (items.wait) {
    return { done: items.done, stage: 'match', cursor: items.next, wait: items.wait, writes };
  }
  if (!items.stopped && items.next < evidence.candidates.length) {
    return { done: items.done, stage: 'match', cursor: items.next, writes };
  }
  const limits = select(evidence, hearing);
  return {
    done: items.done,
    stage: evidence.peers.length > 0 ? 'releases' : 'done',
    cursor: 0,
    limits,
    writes,
  };
}

const nextRangeKept = (evidence: PeerEvidence) =>
  evidence.candidates.filter((c) => c.match?.kept && c.relation === 'next').length;

async function judge(
  candidate: Candidate,
  digest: SongDigest,
  hearing: boolean,
  deadline: number,
): Promise<NonNullable<Candidate['match']>> {
  if (!candidate.sample) {
    return { kept: false, basis: 'metadata-only', explanation: NO_UPLOAD };
  }
  const reply = await matchPeer(
    {
      digest,
      channel: { title: candidate.title, description: candidate.description },
      sample: candidate.sample,
      hearing,
    },
    deadline,
  );
  return {
    kept: reply.channelKind === 'artist' && reply.sound === 'same',
    basis: reply.basis,
    explanation: reply.explanation,
  };
}

/**
 * Sets the run's peers: the kept candidates selected by range and numbered `P1…` in selection
 * order. Returns the limits that selection and the count call for.
 */
function select(evidence: PeerEvidence, hearing: boolean): ResearchLimit[] {
  const { selected, limits } = selectPeers(evidence.candidates.filter((c) => c.match?.kept));
  evidence.peers = selected.map((c, i): Peer => ({
    ref: `P${i + 1}`,
    channelId: c.channelId,
    title: c.title,
    basis: c.match!.basis,
    explanation: c.match!.explanation,
    stats: c.stats,
    bracket: c.bracket,
    relation: c.relation,
    secondary: c.secondary,
  }));
  if (!hearing) limits.push('hearing-off');
  if (selected.length === 0) limits.push('no-peers');
  else if (selected.length < MIN_PEERS) limits.push('few-peers');
  return limits;
}

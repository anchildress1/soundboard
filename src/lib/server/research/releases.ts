// Releases (research R6): from each peer's newest uploads, up to three of its own comparable
// releases, each labeled with why it was chosen. Comparisons stay inside one channel; nothing is
// totaled, ranked or merged across peers. Cursor k is the next peer.
import { getJob } from '#lib/server/jobs/jobs.js';
import { rankHashtags } from '#lib/server/pipeline/hashtags.js';
import { uploadsOf, type PublicUpload } from '#lib/server/platforms/youtube/index.js';
import { eachItem, type Batch, type StageContext } from './batch';
import { engagementRate } from './calculated';
import { readEvidence, saveEvidence, type PeerRelease, type SelectedAs } from './evidence';

const UPLOADS_READ = 10;
/** Two YouTube reads per peer. */
const PEER_MS = 5_000;
const SHORT_MAX_SEC = 180;
const MIN_TOLERANCE_SEC = 60;
const TOLERANCE = 0.25;
const MIN_AGE_MS = 14 * 24 * 60 * 60_000;
const DESCRIPTION_CHARS = 700;

/**
 * Whether a peer's release is about as long as the artist's upload: both known, on the same side of
 * 180 s (a release of 180 s or less may be a Short), and within the larger of 60 s and 25 %.
 */
export function comparableLength(releaseSec: number, uploadSec: number): boolean {
  if (!(releaseSec > 0 && uploadSec > 0)) return false;
  if (releaseSec <= SHORT_MAX_SEC !== uploadSec <= SHORT_MAX_SEC) return false;
  return Math.abs(releaseSec - uploadSec) <= Math.max(MIN_TOLERANCE_SEC, TOLERANCE * uploadSec);
}

/** Published 14 days to 3 years before `retrievedAt`: past the launch spike, still current. */
export function inWindow(publishedAt: string, retrievedAt: Date): boolean {
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return false;
  const oldest = new Date(retrievedAt);
  oldest.setUTCFullYear(oldest.getUTCFullYear() - 3);
  return published >= oldest.getTime() && published <= retrievedAt.getTime() - MIN_AGE_MS;
}

type Chosen = { upload: PublicUpload; selectedAs: SelectedAs };

/** The most recently published of `uploads`. */
const newestOf = (uploads: PublicUpload[]) =>
  uploads.reduce<PublicUpload | undefined>(
    (best, u) => (!best || Date.parse(u.publishedAt) > Date.parse(best.publishedAt) ? u : best),
    undefined,
  );

/** The highest `score` among `uploads`; a null score can't win and a tie goes to the newer one. */
function bestBy(uploads: PublicUpload[], score: (u: PublicUpload) => number | null) {
  let best: { upload: PublicUpload; value: number } | undefined;
  for (const upload of uploads) {
    const value = score(upload);
    if (value === null) continue;
    const newer = best && Date.parse(upload.publishedAt) > Date.parse(best.upload.publishedAt);
    if (!best || value > best.value || (value === best.value && newer)) best = { upload, value };
  }
  return best?.upload;
}

/** Within one peer: its newest comparable release, then the most viewed and most engaged of the rest. */
export function selectReleases(comparable: PublicUpload[]): Chosen[] {
  const chosen: Chosen[] = [];
  const take = (upload: PublicUpload | undefined, selectedAs: SelectedAs) => {
    if (upload) chosen.push({ upload, selectedAs });
  };
  const rest = () => comparable.filter((u) => !chosen.some((c) => c.upload === u));
  take(newestOf(comparable), 'newest');
  take(
    bestBy(rest(), (u) => u.stats.views),
    'most-viewed',
  );
  take(
    bestBy(rest(), (u) => engagementRate(u.stats).value),
    'most-engaged',
  );
  return chosen;
}

export async function releases({ run, deadline }: StageContext): Promise<Batch> {
  const stored = await readEvidence(run.id);
  // Expired or deleted under a long run: nothing left to read from.
  if (!stored) return { done: 1, stage: 'done', cursor: 0 };
  const { evidence, retrievedAt } = stored;
  const lengthSec = (await getJob(run.jobId))?.probe?.durationSec ?? 0;
  const items = await eachItem(evidence.peers, run.cursor, deadline, PEER_MS, async (peer) => {
    const playlist = evidence.candidates.find(
      (c) => c.channelId === peer.channelId,
    )?.uploadsPlaylist;
    const uploads = playlist ? await uploadsOf(playlist, UPLOADS_READ, deadline) : [];
    const comparable = uploads.filter(
      (u) => comparableLength(u.durationSec, lengthSec) && inWindow(u.publishedAt, retrievedAt),
    );
    // A batch redone after a lost commit replaces this peer's releases instead of adding to them.
    evidence.releases = evidence.releases.filter((r) => r.peer !== peer.ref);
    evidence.releases.push(...selectReleases(comparable).map(release(peer.ref)));
    return undefined;
  });
  const finished = items.next >= evidence.peers.length;
  return {
    done: items.done,
    stage: finished ? 'done' : 'releases',
    cursor: finished ? 0 : items.next,
    wait: items.wait,
    writes: (tx, token) => saveEvidence(tx, run.id, token, evidence),
  };
}

const release =
  (peer: string) =>
  ({ upload, selectedAs }: Chosen, i: number): PeerRelease => ({
    ref: `${peer}-R${i + 1}`,
    peer,
    videoId: upload.videoId,
    title: upload.title,
    description: upload.description.slice(0, DESCRIPTION_CHARS),
    tags: upload.tags,
    hashtags: rankHashtags(upload.description),
    durationSec: upload.durationSec,
    publishedAt: upload.publishedAt,
    stats: upload.stats,
    selectedAs,
  });

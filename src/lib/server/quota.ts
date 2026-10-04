import { createHash } from 'node:crypto';
import { db } from './clients';
import { required } from './env';

export const RUNS_PER_DAY = 40;
export const RUNS_PER_IP = 5;
/** `videos.insert` costs 1,600 of the default 10,000 units: six uploads a day, four for visitors. */
export const UPLOADS_PER_DAY = 6;
export const VISITOR_UPLOADS_PER_DAY = 4;

type QuotaDoc = {
  runs: number;
  ips: Record<string, number>;
  uploads: number;
  visitorUploads: number;
};

/** YouTube's quota day starts at midnight Pacific. */
export function quotaDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

/** Raw IPs are never stored; the salted hash only counts runs per address per day. */
export function hashIp(ip: string): string {
  return createHash('sha256')
    .update(`${required('SESSION_SECRET')}:${ip}`)
    .digest('hex')
    .slice(0, 32);
}

const empty = (): QuotaDoc => ({ runs: 0, ips: {}, uploads: 0, visitorUploads: 0 });

/** Counts a signed-out run, or names the cap that stops it. */
export async function reserveVisitorRun(ipHash: string, now = new Date()): Promise<string | null> {
  const ref = db().collection('quota').doc(quotaDay(now));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.exists ? (snap.data() as QuotaDoc) : empty();
    if (doc.runs >= RUNS_PER_DAY)
      return `Today's ${RUNS_PER_DAY} public runs are used up. Try again tomorrow.`;
    const mine = doc.ips[ipHash] ?? 0;
    if (mine >= RUNS_PER_IP) return `${RUNS_PER_IP} runs per visitor per day. Try again tomorrow.`;
    tx.set(ref, { ...doc, runs: doc.runs + 1, ips: { ...doc.ips, [ipHash]: mine + 1 } });
    return null;
  });
}

/** Takes one upload slot. Visitors stop at four, so two always remain for Nathan. */
export async function reserveUpload(visitor: boolean, now = new Date()): Promise<boolean> {
  const ref = db().collection('quota').doc(quotaDay(now));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.exists ? (snap.data() as QuotaDoc) : empty();
    if (doc.uploads >= UPLOADS_PER_DAY) return false;
    if (visitor && doc.visitorUploads >= VISITOR_UPLOADS_PER_DAY) return false;
    tx.set(ref, {
      ...doc,
      uploads: doc.uploads + 1,
      visitorUploads: doc.visitorUploads + (visitor ? 1 : 0),
    });
    return true;
  });
}

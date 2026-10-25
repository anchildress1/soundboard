// One research run per job (research R2, R3): the claim, the token-guarded commit and the pick's
// reads. Every query runs under RLS as the job's owner.
import { randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { query, type Tx } from '#lib/server/core/db.js';
import { pgCode } from '#lib/server/core/errors.js';
import { jobs, researchRuns } from '#lib/server/core/schema.js';

export type RunStage = (typeof researchRuns.$inferSelect)['stage'];
export type ResearchRun = typeof researchRuns.$inferSelect;
/** What a Cloud Tasks delivery names: the claim matches all four against the row. */
export type Delivery = { jobId: string; uid: string; runId: string; seq: number };

export const RESEARCH_LIMITS = [
  'research-unavailable',
  'research-unfinished',
  'analytics-not-shared',
  'youtube-not-connected',
  'private-releases',
  'few-peers',
  'no-peers',
  'hearing-off',
  'same-range-fallback',
  'artist-range-unknown',
  'peer-range-unknown',
  'secondary-only',
] as const;
export type ResearchLimit = (typeof RESEARCH_LIMITS)[number];

/** The pick stops waiting this long after a run started (research R3). */
export const RESEARCH_MAX_MS = 10 * 60_000;
/** A run this old is replaced: its evidence is about to be hidden (data-model "Fresh"). */
export const RUN_EXPIRY_MS = 29 * 24 * 60 * 60_000;
/** Under the 180 s dispatch deadline plus the commit, as the job claim is. */
const CLAIM_TTL_MS = 3 * 60_000;

const finished = (stage: RunStage) => stage === 'done' || stage === 'failed';

/** The job's run, or null; only its owner sees it. */
export async function getRun(jobId: string): Promise<ResearchRun | null> {
  return await query(async (tx) => {
    const [row] = await tx.select().from(researchRuns).where(eq(researchRuns.jobId, jobId));
    return row ?? null;
  });
}

/** Whether a run started too long ago for its evidence to stay fresh through a draft. */
export const expired = (run: ResearchRun, now = Date.now()) =>
  now - run.startedAt.getTime() >= RUN_EXPIRY_MS;

/**
 * Starts the job's run at `learn`, replacing any earlier one; the database gives it a new `id`. The
 * old run's evidence stays under its own `id` until it expires, so earlier citations still resolve.
 */
export async function startRun(
  job: { id: string; ownerUid: string },
  artistId: string,
): Promise<ResearchRun> {
  return await query(async (tx) => {
    await tx.delete(researchRuns).where(eq(researchRuns.jobId, job.id));
    // Raw, so the statement names only the columns the app role may insert.
    await tx.execute(sql`
      insert into ${researchRuns} (job_id, owner_uid, artist_id, stage)
      values (${job.id}, ${job.ownerUid}, ${artistId}, 'learn')
    `);
    const [row] = await tx.select().from(researchRuns).where(eq(researchRuns.jobId, job.id));
    if (!row) throw new Error('The research run was not saved.');
    return row;
  });
}

/**
 * Ends an unfinished run as `failed` with `error` (and the limit for it), clearing any claim so an
 * in-flight batch fails its token check. `tx` joins the caller's transaction (discard).
 */
export async function failRun(
  jobId: string,
  error: string,
  limit: ResearchLimit | null,
  tx?: Tx,
): Promise<void> {
  const write = (t: Tx) =>
    t
      .update(researchRuns)
      .set({
        stage: 'failed',
        error,
        ...(limit ? { limits: sql`array_append(${researchRuns.limits}, ${limit})` } : {}),
        claimToken: null,
        claimUntil: null,
        updatedAt: sql`now()`,
        finishedAt: sql`now()`,
      })
      .where(
        and(eq(researchRuns.jobId, jobId), sql`${researchRuns.stage} not in ('done', 'failed')`),
      );
  await (tx ? write(tx) : query(write));
}

/** Drops a failed run so the next pick starts a new one; only a re-run does this (T054). */
export async function clearFailedRun(tx: Tx, jobId: string): Promise<void> {
  await tx
    .delete(researchRuns)
    .where(and(eq(researchRuns.jobId, jobId), eq(researchRuns.stage, 'failed')));
}

export type Claim =
  | { kind: 'claimed'; run: ResearchRun; token: string }
  /** Nothing to do for this delivery: answer 200 so Cloud Tasks drops it. */
  | { kind: 'stale' }
  /** The claim is held, or this delivery arrived before the commit it follows: retry later. */
  | { kind: 'retry' };

/** Claims the run named by `delivery` with one conditional update (research R2 step 3). */
export async function claim(delivery: Delivery): Promise<Claim> {
  const token = randomBytes(16).toString('hex');
  return await query(async (tx) => {
    const [run] = await tx
      .update(researchRuns)
      .set({
        claimToken: token,
        claimUntil: sql`now() + ${CLAIM_TTL_MS}::int * interval '1 millisecond'`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(researchRuns.jobId, delivery.jobId),
          eq(researchRuns.id, delivery.runId),
          eq(researchRuns.ownerUid, delivery.uid),
          eq(researchRuns.seq, delivery.seq),
          sql`${researchRuns.stage} not in ('done', 'failed')`,
          or(isNull(researchRuns.claimUntil), lt(researchRuns.claimUntil, sql`now()`)),
          sql`exists (select 1 from ${jobs} j where j.id = ${researchRuns.jobId} and j.state <> 'DISCARDED')`,
        ),
      )
      .returning();
    if (run) return { kind: 'claimed', run, token };
    const [row] = await tx
      .select()
      .from(researchRuns)
      .where(and(eq(researchRuns.jobId, delivery.jobId), eq(researchRuns.id, delivery.runId)));
    // A missing row also covers an inactive owner and another user's job: RLS hides both.
    if (!row || row.ownerUid !== delivery.uid || finished(row.stage)) return { kind: 'stale' };
    if (delivery.seq < row.seq) return { kind: 'stale' };
    const [live] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.id, delivery.jobId), sql`${jobs.state} <> 'DISCARDED'`));
    return live ? { kind: 'retry' } : { kind: 'stale' };
  });
}

/** Where a committed batch leaves the run. */
export type Release = {
  stage: RunStage;
  cursor: number;
  wait: string | null;
  consecutiveFailures: number;
  limits: string[];
  error: string | null;
};

/** Thrown inside the commit to roll back every write when the release finds the claim gone. */
class ClaimLost extends Error {}

/** `55000` is what every claim-checked write function raises once the claim is gone. */
const claimLost = (error: unknown) => error instanceof ClaimLost || pgCode(error) === '55000';

/**
 * Commits one batch (research R2 step 7): `writes` (each claim-checked in SQL), then the release
 * with the same token, in one transaction. Returns false when the claim was lost, with nothing
 * written.
 */
export async function commit(
  run: ResearchRun,
  token: string,
  release: Release,
  writes?: (tx: Tx) => Promise<void>,
): Promise<boolean> {
  try {
    await query(async (tx) => {
      await writes?.(tx);
      const released = await tx
        .update(researchRuns)
        .set({
          ...release,
          seq: sql`${researchRuns.seq} + 1`,
          claimToken: null,
          claimUntil: null,
          updatedAt: sql`now()`,
          finishedAt: finished(release.stage) ? sql`now()` : null,
        })
        .where(
          and(
            eq(researchRuns.id, run.id),
            eq(researchRuns.claimToken, token),
            sql`${researchRuns.claimUntil} > now()`,
          ),
        )
        .returning({ id: researchRuns.id });
      if (released.length === 0) throw new ClaimLost();
    });
    return true;
  } catch (error) {
    if (claimLost(error)) return false;
    throw error;
  }
}

/** Gives the claim back with nothing advanced, so the redelivery of the same `seq` starts clean. */
export async function release(run: ResearchRun, token: string): Promise<void> {
  await query((tx) =>
    tx
      .update(researchRuns)
      .set({ claimToken: null, claimUntil: null, updatedAt: sql`now()` })
      .where(and(eq(researchRuns.id, run.id), eq(researchRuns.claimToken, token))),
  );
}

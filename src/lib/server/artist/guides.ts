import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  Approved,
  BrandGuide,
  GuideKind,
  GuideState,
  Proposal,
  ProposalSources,
  SourceSummary,
  VoiceRules,
} from '#lib/brand.js';
import type { Wait } from '#lib/types.js';
import { ModelBusy, ModelQuotaSpent, stepDeadline } from '#lib/server/ai/model.js';
import { query, type Tx } from '#lib/server/core/db.js';
import { ActionError, pgCode } from '#lib/server/core/errors.js';
import { artistGuides, guideClaims, users } from '#lib/server/core/schema.js';

/** Each kind's body. */
export type Bodies = { voice: VoiceRules; brand: BrandGuide };

export const CLAIM_HELD = 'A proposal is already running in another tab.';
export const GUIDE_CHANGED = 'The guide changed in another tab. Reload to see it.';

type Row = Pick<typeof artistGuides.$inferSelect, 'id' | 'body' | 'sources' | 'proposedAt'> & {
  approvedAt?: Date | null;
};

// Drizzle reads timestamps as Dates; rows from a function call come back as the driver's raw value.
const iso = (at: Date | string) => new Date(at).toISOString();

const toProposal = <B>(row: Row): Proposal<B> => ({
  id: row.id,
  body: row.body as B,
  sources: row.sources as ProposalSources,
  proposedAt: iso(row.proposedAt),
});

const toApproved = <B>(row: Row): Approved<B> => ({
  body: row.body as B,
  sources: row.sources as SourceSummary,
  proposedAt: iso(row.proposedAt),
  approvedAt: iso(row.approvedAt!),
});

const ofKind = (artistId: string, kind: GuideKind) =>
  and(eq(artistGuides.artistId, artistId), eq(artistGuides.kind, kind));

/** Both kinds' approved version, pending proposal and future quota hold, for the brand page. */
export async function getGuides(
  artistId: string,
): Promise<{ voice: GuideState<VoiceRules>; brand: GuideState<BrandGuide> }> {
  const [rows, holds] = await query((tx) =>
    Promise.all([
      tx.select().from(artistGuides).where(eq(artistGuides.artistId, artistId)),
      tx
        .select({ kind: guideClaims.kind, limitUntil: guideClaims.limitUntil })
        .from(guideClaims)
        .where(and(eq(guideClaims.artistId, artistId), gt(guideClaims.limitUntil, sql`now()`))),
    ]),
  );
  const state = <B>(kind: GuideKind): GuideState<B> => {
    const approved = rows.find((r) => r.kind === kind && r.status === 'approved');
    const proposal = rows.find((r) => r.kind === kind && r.status === 'proposed');
    const hold = holds.find((h) => h.kind === kind)?.limitUntil;
    return {
      approved: approved ? toApproved<B>(approved) : null,
      proposal: proposal ? toProposal<B>(proposal) : null,
      limitUntil: hold ? hold.getTime() : null,
    };
  };
  return { voice: state('voice'), brand: state('brand') };
}

/** The artist's approved voice and brand guide, as picks and hooks read them. */
export async function approvedGuides(
  artistId: string,
): Promise<{ voice: VoiceRules | null; brand: BrandGuide | null }> {
  const rows = await query((tx) =>
    tx
      .select({ kind: artistGuides.kind, body: artistGuides.body })
      .from(artistGuides)
      .where(and(eq(artistGuides.artistId, artistId), eq(artistGuides.status, 'approved'))),
  );
  const body = (kind: GuideKind) => rows.find((r) => r.kind === kind)?.body ?? null;
  return { voice: body('voice') as VoiceRules | null, brand: body('brand') as BrandGuide | null };
}

export type Claim = { token: string } | { wait: 'model quota spent'; limitUntil: number };

/**
 * Claims the caller's (artist, kind) proposal slot for one step. The database sets the claim time
 * and the connection generation. A quota hold answers its wait; a running claim is a 409.
 */
export async function claimProposal(kind: GuideKind): Promise<Claim> {
  const token = randomUUID();
  const [row] = await query(async (tx) => {
    const result = (await tx.execute(sql`select claim_token = ${token} as claimed,
      limit_until > now() as held, (extract(epoch from limit_until) * 1000)::float8 as "limitUntil"
      from public.soundboard_claim_proposal(${kind}, ${token})`)) as {
      rows: { claimed: boolean; held: boolean | null; limitUntil: number | null }[];
    };
    return result.rows;
  });
  if (row?.claimed) return { token };
  if (row?.held) return { wait: 'model quota spent', limitUntil: row.limitUntil! };
  throw new ActionError(409, CLAIM_HELD);
}

/** Frees the slot if `token` still holds it; `limitUntil` holds every claim until the quota resets. */
export async function releaseProposal(
  artistId: string,
  kind: GuideKind,
  token: string,
  limitUntil?: number,
): Promise<void> {
  await query((tx) =>
    tx
      .update(guideClaims)
      .set({
        claimToken: null,
        claimUntil: null,
        ...(limitUntil === undefined ? {} : { limitUntil: new Date(limitUntil) }),
      })
      .where(
        and(
          eq(guideClaims.artistId, artistId),
          eq(guideClaims.kind, kind),
          eq(guideClaims.claimToken, token),
        ),
      ),
  );
}

/**
 * Saves a proposal through `soundboard_save_proposal`, replacing any earlier one. Null when the
 * grant the claim saw is gone (`28000`); a lost claim is the running-claim 409.
 */
export async function saveProposal<K extends GuideKind>(
  kind: K,
  body: Bodies[K],
  sources: ProposalSources,
  token: string,
): Promise<Proposal<Bodies[K]> | null> {
  try {
    return await query(async (tx) => {
      const result = (await tx.execute(sql`select id, body, sources, proposed_at as "proposedAt"
        from public.soundboard_save_proposal(${kind}, ${JSON.stringify(body)}::jsonb,
          ${JSON.stringify(sources)}::jsonb, ${token})`)) as { rows: Row[] };
      return toProposal<Bodies[K]>(result.rows[0]!);
    });
  } catch (error) {
    if (pgCode(error) === '28000') return null;
    if (pgCode(error) === '55000') throw new ActionError(409, CLAIM_HELD);
    throw error;
  }
}

/** The pending proposal named `proposalId`, locked; a stale, expired or foreign one is a 404. */
async function lockProposal(tx: Tx, artistId: string, kind: GuideKind, proposalId: number) {
  const [row] = await tx
    .select()
    .from(artistGuides)
    .where(
      and(
        ofKind(artistId, kind),
        eq(artistGuides.status, 'proposed'),
        eq(artistGuides.id, proposalId),
      ),
    )
    .for('update');
  if (!row) throw new ActionError(404, GUIDE_CHANGED);
  return row;
}

/**
 * Makes the edited proposal the approved version and deletes the proposal. Only the approved row's
 * body, sources and times change, so columns other specs add to it survive (research R10).
 */
export async function approveGuide<K extends GuideKind>(
  artistId: string,
  kind: K,
  proposalId: number,
  body: Bodies[K],
): Promise<Approved<Bodies[K]>> {
  return await query(async (tx) => {
    const pending = await lockProposal(tx, artistId, kind, proposalId);
    const read = pending.sources as ProposalSources;
    const sources: SourceSummary = {
      uploads: read.uploads.length,
      drafts: read.drafts.length,
      edits: read.edits,
      approvals: read.approvals,
      carriedOver: false,
    };
    const set = { body, sources, proposedAt: pending.proposedAt, approvedAt: sql`now()` };
    const [row] = await tx
      .insert(artistGuides)
      .values({ artistId, kind, status: 'approved', ...set })
      .onConflictDoUpdate({
        target: [artistGuides.artistId, artistGuides.kind, artistGuides.status],
        set,
      })
      .returning();
    await tx.delete(artistGuides).where(eq(artistGuides.id, pending.id));
    return toApproved<Bodies[K]>(row!);
  });
}

/** Deletes the pending proposal named `proposalId`; the approved version stays. */
export async function discardProposal(
  artistId: string,
  kind: GuideKind,
  proposalId: number,
): Promise<void> {
  await query(async (tx) => {
    const pending = await lockProposal(tx, artistId, kind, proposalId);
    await tx.delete(artistGuides).where(eq(artistGuides.id, pending.id));
  });
}

/**
 * Deletes the caller's proposals read through the grant of generation `grantAt` (its connection's
 * `updated_at`) or any older grant it replaced, in the transaction that revokes it. With `unbound`,
 * set when this revoke removed the user's current grant, proposals saved with no grant go too. A
 * newer grant's proposals stay.
 */
export async function dropProposals(
  tx: Tx,
  uid: string,
  grantAt: Date,
  unbound: boolean,
): Promise<void> {
  const bound = lte(artistGuides.grantAt, grantAt);
  await tx.delete(artistGuides).where(
    and(
      eq(artistGuides.status, 'proposed'),
      unbound ? or(bound, isNull(artistGuides.grantAt)) : bound,
      inArray(
        artistGuides.artistId,
        tx
          .select({ id: sql<string>`${users.artistId}` })
          .from(users)
          .where(eq(users.uid, uid)),
      ),
    ),
  );
}

export type ProposeResult<B> =
  | { proposal: Proposal<B> }
  | { wait: Exclude<Wait, 'model quota spent'> }
  | { wait: 'model quota spent'; limitUntil: number };

/** What a proposal step's reads and model call produce: a wait, or the proposal to save. */
export type ProposalDraft<B> =
  { wait: Exclude<Wait, 'model quota spent'> } | { body: B; sources: ProposalSources };

/**
 * One page-driven proposal step (research R8). The step deadline starts first and is shared by the
 * claim and `work`'s reads and model call. A busy model answers its wait; a spent quota holds the
 * slot until the reset; a grant lost before the save waits on a reconnect. Nothing is stored
 * except the saved proposal, and the claim is always released.
 */
export async function proposeStep<K extends GuideKind>(
  artistId: string,
  kind: K,
  work: (deadline: number) => Promise<ProposalDraft<Bodies[K]>>,
): Promise<ProposeResult<Bodies[K]>> {
  const deadline = stepDeadline();
  const claim = await claimProposal(kind);
  if ('wait' in claim) return claim;
  let limitUntil: number | undefined;
  try {
    const draft = await work(deadline);
    if ('wait' in draft) return draft;
    const proposal = await saveProposal(kind, draft.body, draft.sources, claim.token);
    return proposal ? { proposal } : { wait: 'reconnect YouTube' };
  } catch (error) {
    if (error instanceof ModelBusy) return { wait: 'model busy' };
    if (!(error instanceof ModelQuotaSpent)) throw error;
    limitUntil = error.until;
    return { wait: 'model quota spent', limitUntil };
  } finally {
    await releaseProposal(artistId, kind, claim.token, limitUntil);
  }
}

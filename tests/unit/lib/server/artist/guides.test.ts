// @vitest-environment node
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProposalSources } from '#lib/brand.js';
import { DEFAULT_INFLUENCE, type Influence } from '#lib/influence.js';
import { ModelBusy, ModelQuotaSpent } from '#lib/server/ai/model.js';
import {
  approveGuide,
  approvedGuides,
  CLAIM_HELD,
  claimProposal,
  discardProposal,
  getGuides,
  GUIDE_CHANGED,
  influenceSettings,
  NO_BRAND_GUIDE,
  proposeStep,
  releaseProposal,
  saveInfluence,
  saveProposal,
} from '#lib/server/artist/guides.js';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { artistGuides, connections, guideClaims } from '#lib/server/core/schema.js';
import { seed, truncate } from '../../../../helpers/db';
import {
  approvedGuide,
  ARTIST_A,
  ARTIST_C,
  NATHAN_VOICE_RULES,
  pendingProposal,
  USER_A,
  USER_C,
  USERS,
} from '../../../../helpers/pipeline';

const C = ARTIST_C.id;
const asC = <T>(operation: () => Promise<T>) => withIdentity(USER_C.uid, operation);
const VOICE = { rules: ['Plain.'] };
const GUIDE = { statement: 'S.', keep: ['K'], fix: [], drop: [] };
const EDITS: ProposalSources = { uploads: [], drafts: [], edits: 3, approvals: 1, thin: true };
const UPLOADS: ProposalSources = {
  ...EDITS,
  uploads: [{ videoId: 'v1', title: 'Song', publishedAt: '2026-10-01T00:00:00Z' }],
};

const stored = () => db().select().from(artistGuides).orderBy(artistGuides.id);
const claims = () => db().select().from(guideClaims);

beforeEach(async () => {
  await truncate();
  await seed(USERS);
});

describe('getGuides', () => {
  it('has neither guide before the first proposal', async () => {
    const none = { approved: null, proposal: null, limitUntil: null };
    expect(await asC(() => getGuides(C))).toEqual({ voice: none, brand: none });
  });

  it("shows Nathan's carried-over voice, and never to another artist", async () => {
    const guides = await withIdentity(USER_A.uid, () => getGuides(ARTIST_A.id));
    expect(guides.voice.approved).toMatchObject({
      body: { rules: NATHAN_VOICE_RULES },
      sources: { carriedOver: true },
      proposedAt: expect.any(String),
      approvedAt: expect.any(String),
    });
    expect((await asC(() => getGuides(ARTIST_A.id))).voice.approved).toBeNull();
  });

  it('answers each pending proposal and a future quota hold, but not a past one', async () => {
    await seed({ artistGuides: [pendingProposal(C, 'brand', GUIDE, { sources: UPLOADS })] });
    const until = Date.now() + 60_000;
    await asC(async () => {
      const claim = await claimProposal('voice');
      await releaseProposal(C, 'voice', (claim as { token: string }).token, until);
      const brand = await claimProposal('brand');
      await releaseProposal(C, 'brand', (brand as { token: string }).token, Date.now() - 1);
    });
    const guides = await asC(() => getGuides(C));
    expect(guides.brand).toMatchObject({
      proposal: { id: expect.any(Number), body: GUIDE, sources: UPLOADS },
      limitUntil: null,
    });
    expect(guides.voice).toEqual({ approved: null, proposal: null, limitUntil: until });
  });
});

const MINE: Influence = { sound: 0, feel: 2, wording: 3, discovery: 4, structure: 1 };
const OTHER: Influence = { sound: 4, feel: 4, wording: 4, discovery: 0, structure: 0 };
const brandInfluence = (artistId: string) =>
  db()
    .select({ influence: artistGuides.influence })
    .from(artistGuides)
    .where(and(eq(artistGuides.artistId, artistId), eq(artistGuides.kind, 'brand')));

describe('approvedGuides', () => {
  it('returns only approved bodies, never a proposal, with the default influence', async () => {
    await seed({
      artistGuides: [approvedGuide(C, 'brand', GUIDE), pendingProposal(C, 'voice', VOICE)],
    });
    expect(await asC(() => approvedGuides(C))).toEqual({
      voice: null,
      brand: GUIDE,
      influence: DEFAULT_INFLUENCE,
    });
  });

  it('returns the influence saved on the brand guide', async () => {
    await seed({ artistGuides: [{ ...approvedGuide(C, 'brand', GUIDE), influence: MINE }] });
    expect((await asC(() => approvedGuides(C))).influence).toEqual(MINE);
  });

  it('returns the defaults when there is no brand guide', async () => {
    expect((await asC(() => approvedGuides(C))).influence).toEqual(DEFAULT_INFLUENCE);
  });
});

describe('influenceSettings', () => {
  it('has the defaults, unsaved, and cannot save without an approved brand guide', async () => {
    await seed({ artistGuides: [pendingProposal(C, 'brand', GUIDE)] });
    expect(await asC(() => influenceSettings(C))).toEqual({
      influence: DEFAULT_INFLUENCE,
      saved: false,
      canSave: false,
    });
  });

  it('can save on an approved brand guide that has no settings yet', async () => {
    await seed({ artistGuides: [approvedGuide(C, 'brand', GUIDE)] });
    expect(await asC(() => influenceSettings(C))).toEqual({
      influence: DEFAULT_INFLUENCE,
      saved: false,
      canSave: true,
    });
  });

  it('returns saved settings, and never another artist’s', async () => {
    await seed({ artistGuides: [{ ...approvedGuide(C, 'brand', GUIDE), influence: MINE }] });
    expect(await asC(() => influenceSettings(C))).toEqual({
      influence: MINE,
      saved: true,
      canSave: true,
    });
    expect((await asC(() => influenceSettings(ARTIST_A.id))).canSave).toBe(false);
  });
});

describe('saveInfluence', () => {
  it('saves on the approved brand row and reads back', async () => {
    await seed({ artistGuides: [approvedGuide(C, 'brand', GUIDE)] });
    await asC(() => saveInfluence(MINE));
    expect(await brandInfluence(C)).toEqual([{ influence: MINE }]);
    expect((await asC(() => approvedGuides(C))).influence).toEqual(MINE);
  });

  it('replaces earlier settings and leaves the guide itself untouched', async () => {
    await seed({ artistGuides: [approvedGuide(C, 'brand', GUIDE)] });
    const [before] = await db().select().from(artistGuides).where(eq(artistGuides.artistId, C));
    await asC(() => saveInfluence(MINE));
    await asC(() => saveInfluence(OTHER));
    const [after] = await db().select().from(artistGuides).where(eq(artistGuides.artistId, C));
    expect(after).toEqual({ ...before, influence: OTHER });
  });

  it('survives approving the next brand proposal', async () => {
    await seed({
      artistGuides: [
        { ...approvedGuide(C, 'brand', GUIDE), influence: MINE },
        pendingProposal(C, 'brand', GUIDE),
      ],
    });
    const [pending] = await db()
      .select()
      .from(artistGuides)
      .where(and(eq(artistGuides.artistId, C), eq(artistGuides.status, 'proposed')));
    await asC(() => approveGuide(C, 'brand', pending!.id, { ...GUIDE, statement: 'New.' }));
    expect((await asC(() => approvedGuides(C))).influence).toEqual(MINE);
  });

  it('409s with no approved brand guide, even with a proposal pending', async () => {
    await seed({ artistGuides: [pendingProposal(C, 'brand', GUIDE)] });
    await expect(asC(() => saveInfluence(MINE))).rejects.toMatchObject({
      status: 409,
      message: NO_BRAND_GUIDE,
    });
    expect(await brandInfluence(C)).toEqual([{ influence: null }]);
  });

  it('never writes another artist’s brand guide', async () => {
    await seed({ artistGuides: [approvedGuide(C, 'brand', GUIDE)] });
    await expect(withIdentity(USER_A.uid, () => saveInfluence(MINE))).rejects.toMatchObject({
      status: 409,
    });
    expect(await brandInfluence(C)).toEqual([{ influence: null }]);
  });

  it('refuses settings the database check rejects', async () => {
    await seed({ artistGuides: [approvedGuide(C, 'brand', GUIDE)] });
    await expect(
      asC(() => saveInfluence({ ...MINE, sound: 9 } as unknown as Influence)),
    ).rejects.toThrow();
    expect(await brandInfluence(C)).toEqual([{ influence: null }]);
  });
});

describe('claimProposal', () => {
  it('claims once and 409s a second claim while the first holds', async () => {
    await asC(async () => {
      expect(await claimProposal('voice')).toEqual({ token: expect.any(String) });
      await expect(claimProposal('voice')).rejects.toMatchObject({
        status: 409,
        message: CLAIM_HELD,
      });
      // Kinds claim apart.
      expect(await claimProposal('brand')).toEqual({ token: expect.any(String) });
    });
  });

  it('claims again once the first is released, and copies the grant generation', async () => {
    const [connection] = await db()
      .select({ updatedAt: connections.updatedAt })
      .from(connections)
      .where(eq(connections.uid, USER_C.uid));
    await asC(async () => {
      const { token } = (await claimProposal('voice')) as { token: string };
      await releaseProposal(C, 'voice', token);
      expect(await claimProposal('voice')).toEqual({ token: expect.any(String) });
    });
    expect(await claims()).toMatchObject([{ grantAt: connection!.updatedAt }]);
  });

  it('answers a quota hold with its reset, claiming nothing', async () => {
    const until = Date.now() + 60_000;
    await asC(async () => {
      const { token } = (await claimProposal('voice')) as { token: string };
      await releaseProposal(C, 'voice', token, until);
      expect(await claimProposal('voice')).toEqual({
        wait: 'model quota spent',
        limitUntil: until,
      });
    });
    expect(await claims()).toMatchObject([{ claimToken: null }]);
  });

  it('takes over a claim left past its expiry', async () => {
    await asC(() => claimProposal('voice'));
    await db().execute(sql`update guide_claims set claim_until = now() - interval '1 second'`);
    expect(await asC(() => claimProposal('voice'))).toEqual({ token: expect.any(String) });
  });

  it("leaves another tab's claim alone when released with a stale token", async () => {
    await asC(async () => {
      const { token } = (await claimProposal('voice')) as { token: string };
      await releaseProposal(C, 'voice', 'stale');
      expect((await claims())[0]!.claimToken).toBe(token);
    });
  });
});

describe('saveProposal', () => {
  it('saves under the claim, replacing the earlier proposal, at the claim time', async () => {
    await seed({ artistGuides: [pendingProposal(C, 'voice', { rules: ['old'] })] });
    const saved = await asC(async () => {
      const { token } = (await claimProposal('voice')) as { token: string };
      return saveProposal('voice', VOICE, UPLOADS, token);
    });
    const [claim] = await claims();
    expect(saved).toEqual({
      id: expect.any(Number),
      body: VOICE,
      sources: UPLOADS,
      proposedAt: claim!.claimedAt!.toISOString(),
    });
    expect((await stored()).filter((row) => row.status === 'proposed')).toMatchObject([
      { id: saved!.id, body: VOICE },
    ]);
  });

  it('409s once the claim is lost', async () => {
    await expect(asC(() => saveProposal('voice', VOICE, EDITS, 'never'))).rejects.toMatchObject({
      status: 409,
      message: CLAIM_HELD,
    });
  });

  it('waits on a reconnect when YouTube was disconnected and reconnected before the save', async () => {
    const saved = await asC(async () => {
      const { token } = (await claimProposal('voice')) as { token: string };
      await db().delete(connections).where(eq(connections.uid, USER_C.uid));
      await seed({
        connections: [{ ...USERS.connections[1]!, tokenCiphertext: 'bmV3', updatedAt: new Date() }],
      });
      return saveProposal('voice', VOICE, UPLOADS, token);
    });
    expect(saved).toBeNull();
    expect((await stored()).filter((row) => row.artistId === C)).toEqual([]);
  });

  it('saves edits alone with no grant at all', async () => {
    await db().delete(connections).where(eq(connections.uid, USER_C.uid));
    const saved = await asC(async () => {
      const { token } = (await claimProposal('voice')) as { token: string };
      return saveProposal('voice', VOICE, EDITS, token);
    });
    expect(saved).toMatchObject({ body: VOICE });
  });

  it('rethrows any other database error', async () => {
    await expect(
      asC(async () => {
        const { token } = (await claimProposal('voice')) as { token: string };
        // A missing key fails the sources check.
        return saveProposal('voice', VOICE, { uploads: [] } as unknown as ProposalSources, token);
      }),
    ).rejects.toThrow();
  });
});

describe('approveGuide', () => {
  const proposalId = async () =>
    (await stored()).find((row) => row.artistId === C && row.status === 'proposed')!.id;

  beforeEach(() =>
    seed({
      artistGuides: [pendingProposal(C, 'voice', { rules: ['proposed'] }, { sources: UPLOADS })],
    }),
  );

  it('approves the edited body, collapsing sources to counts, and deletes the proposal', async () => {
    const id = await proposalId();
    const approved = await asC(() => approveGuide(C, 'voice', id, VOICE));
    expect(approved).toEqual({
      body: VOICE,
      sources: { uploads: 1, drafts: 0, edits: 3, approvals: 1, carriedOver: false },
      proposedAt: expect.any(String),
      approvedAt: expect.any(String),
    });
    expect(JSON.stringify(await stored())).not.toContain('v1');
    expect((await stored()).filter((row) => row.artistId === C)).toMatchObject([
      { status: 'approved', body: VOICE, grantAt: null },
    ]);
  });

  it('replaces the earlier approved version in place', async () => {
    await seed({ artistGuides: [approvedGuide(C, 'voice', { rules: ['older'] })] });
    const before = (await stored()).find((row) => row.status === 'approved' && row.artistId === C)!;
    await asC(async () => approveGuide(C, 'voice', await proposalId(), VOICE));
    const after = (await stored()).filter((row) => row.artistId === C);
    expect(after).toMatchObject([{ id: before.id, status: 'approved', body: VOICE }]);
  });

  it.each([
    ['another id', async (id: number) => id + 100, C],
    ["another artist's", async (id: number) => id, ARTIST_A.id],
  ])('404s on %s proposal, writing nothing', async (_label, pick, artistId) => {
    const id = await pick(await proposalId());
    await expect(asC(() => approveGuide(artistId, 'voice', id, VOICE))).rejects.toMatchObject({
      status: 404,
      message: GUIDE_CHANGED,
    });
    expect((await stored()).filter((row) => row.artistId === C)).toMatchObject([
      { status: 'proposed' },
    ]);
  });

  it('404s on an expired proposal', async () => {
    const id = await proposalId();
    await db()
      .update(artistGuides)
      .set({ proposedAt: new Date(Date.now() - 29 * 24 * 3600_000) })
      .where(eq(artistGuides.id, id));
    await expect(asC(() => approveGuide(C, 'voice', id, VOICE))).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('discardProposal', () => {
  it('deletes the proposal and keeps the approved version', async () => {
    await seed({
      artistGuides: [approvedGuide(C, 'brand', GUIDE), pendingProposal(C, 'brand', GUIDE)],
    });
    const id = (await stored()).find((row) => row.status === 'proposed' && row.artistId === C)!.id;
    await asC(() => discardProposal(C, 'brand', id));
    expect((await stored()).filter((row) => row.artistId === C)).toMatchObject([
      { status: 'approved' },
    ]);
    await expect(asC(() => discardProposal(C, 'brand', id))).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('proposeStep', () => {
  const step = (work: Parameters<typeof proposeStep<'voice'>>[2]) =>
    asC(() => proposeStep(C, 'voice', work));

  it('saves the draft and frees the slot', async () => {
    const work = vi.fn(async () => ({ body: VOICE, sources: EDITS }));
    expect(await step(work)).toMatchObject({ proposal: { body: VOICE } });
    expect(work).toHaveBeenCalledWith(expect.any(Number));
    expect(await claims()).toMatchObject([{ claimToken: null, limitUntil: null }]);
  });

  it('answers the work wait, saving nothing', async () => {
    expect(await step(async () => ({ wait: 'waiting on YouTube' }))).toEqual({
      wait: 'waiting on YouTube',
    });
    expect(await claims()).toMatchObject([{ claimToken: null }]);
  });

  it('answers model busy on a busy model', async () => {
    expect(
      await step(async () => {
        throw new ModelBusy('busy');
      }),
    ).toEqual({ wait: 'model busy' });
  });

  it('holds the slot until the quota reset on a spent quota', async () => {
    const until = Date.now() + 3_600_000;
    expect(
      await step(async () => {
        throw new ModelQuotaSpent('spent', until);
      }),
    ).toEqual({ wait: 'model quota spent', limitUntil: until });
    const work = vi.fn();
    expect(await step(work)).toEqual({ wait: 'model quota spent', limitUntil: until });
    expect(work).not.toHaveBeenCalled();
  });

  it('waits on a reconnect when the grant is gone before the save', async () => {
    expect(
      await step(async () => {
        await db().delete(connections).where(eq(connections.uid, USER_C.uid));
        return { body: VOICE, sources: UPLOADS };
      }),
    ).toEqual({ wait: 'reconnect YouTube' });
  });

  it('frees the slot and rethrows any other error', async () => {
    await expect(
      step(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await claims()).toMatchObject([{ claimToken: null }]);
  });
});

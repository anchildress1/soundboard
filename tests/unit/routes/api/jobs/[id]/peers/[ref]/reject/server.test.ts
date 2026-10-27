// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { jobResearch, jobs, peerRejections } from '#lib/server/core/schema.js';
import { rejectedChannels, type PeerEvidence } from '#lib/server/research/evidence.js';
import { POST } from '#src/routes/api/jobs/[id]/peers/[ref]/reject/+server.js';
import { seed, truncate } from '../../../../../../../../helpers/db';
import {
  A_JOB,
  seedJob,
  USER_A,
  USER_B,
  USER_C,
  USERS,
} from '../../../../../../../../helpers/pipeline';

type Event = Parameters<typeof POST>[0];
type User = typeof USER_A | typeof USER_B | typeof USER_C;

const request = (body: unknown) =>
  new Request('http://localhost/reject', { method: 'POST', body: JSON.stringify(body) });

const reject = async (
  id: string,
  ref: string,
  user: User = USER_A,
  body: unknown = { version: 1 },
) =>
  await withIdentity(user.uid, () =>
    POST({ params: { id, ref }, locals: { user }, request: request(body) } as unknown as Event),
  );

const EVIDENCE: PeerEvidence = {
  query: 'synthwave music',
  artist: { stats: null, bracket: 100 },
  candidates: [],
  peers: [
    {
      ref: 'P1',
      channelId: 'UCpeer1',
      title: 'Peer 1',
      basis: 'heard',
      explanation: 'Same palette.',
      stats: { subscribers: 1200, hidden: false, videos: 40, views: 90_000 },
      bracket: 1000,
      relation: 'next',
      secondary: false,
    },
  ],
  releases: [],
  skipped: [],
};

const pick = (researchRunId: string | null) => ({
  version: 1,
  title: 'T',
  hashtags: [],
  tags: [],
  skipped: false,
  researchRunId,
});

async function put(researchRunId: string | null = 'run-1', ageDays = 1) {
  await seedJob({ ...A_JOB, id: 'j1', state: 'REVIEW' });
  await db()
    .update(jobs)
    .set({ picks: [pick(researchRunId)] })
    .where(eq(jobs.id, 'j1'));
  await seed({
    jobResearch: [
      {
        runId: 'run-1',
        jobId: 'j1',
        retrievedAt: new Date(Date.now() - ageDays * 24 * 60 * 60_000),
        evidence: EVIDENCE,
      },
    ],
  });
}

const rejections = () => db().select().from(peerRejections);

beforeEach(async () => {
  await truncate();
  await seed(USERS);
});

describe('POST /api/jobs/[id]/peers/[ref]/reject', () => {
  it("records the peer's channel for the artist and names the ref", async () => {
    await put();
    const response = await reject('j1', 'P1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rejected: 'P1' });
    expect(await rejections()).toMatchObject([{ artistId: USER_A.artistId, channelId: 'UCpeer1' }]);
  });

  it('leaves the pick and its evidence as they were', async () => {
    await put();
    await reject('j1', 'P1');
    expect(await db().select().from(jobResearch)).toHaveLength(1);
    const [row] = await db().select({ picks: jobs.picks }).from(jobs);
    expect(row?.picks).toEqual([pick('run-1')]);
  });

  it('refreshes an existing rejection instead of adding another', async () => {
    await put();
    await reject('j1', 'P1');
    await db()
      .update(peerRejections)
      .set({ retrievedAt: new Date(Date.now() - 5 * 24 * 60 * 60_000) });
    await reject('j1', 'P1');
    const rows = await rejections();
    expect(rows).toHaveLength(1);
    expect(Date.now() - rows[0]!.retrievedAt.getTime()).toBeLessThan(60_000);
  });

  it('is what a later discover reads as rejected, for this artist only', async () => {
    await put();
    await reject('j1', 'P1');
    expect(await withIdentity(USER_A.uid, rejectedChannels)).toEqual(['UCpeer1']);
    expect(await withIdentity(USER_C.uid, rejectedChannels)).toEqual([]);
  });

  it("404s another user's job and records nothing", async () => {
    await put();
    const error = await reject('j1', 'P1', USER_C).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(await rejections()).toEqual([]);
  });

  it('404s an unknown job', async () => {
    const error = await reject('ghost', 'P1').catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
  });

  it('404s a job with no artist', async () => {
    await seedJob({ id: 'j2', ownerUid: USER_B.uid, artistId: null, state: 'REVIEW' });
    const error = await reject('j2', 'P1', USER_B).catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
  });

  it('404s a job whose owner has since relinked to another artist, and records nothing', async () => {
    await put();
    await db().execute(sql`insert into artists (id, name) values ('artist-new', 'New Artist')`);
    await db().execute(sql`update users set artist_id = 'artist-new' where uid = ${USER_A.uid}`);
    const error = await reject('j1', 'P1').catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(await rejections()).toEqual([]);
  });

  it('404s a job whose owner has since been unlinked from every artist, and records nothing', async () => {
    await put();
    await db().execute(sql`update users set artist_id = null where uid = ${USER_A.uid}`);
    const error = await reject('j1', 'P1').catch((e: unknown) => e);
    expect(isHttpError(error) && error.status).toBe(404);
    expect(await rejections()).toEqual([]);
  });

  it.each([
    ['an unknown peer', 'P9'],
    ['a release, which is not a peer', 'P1-R1'],
    ['text that is not a ref', 'x'],
  ])('409s %s', async (_name, ref) => {
    await put();
    const response = await reject('j1', ref);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "That peer's evidence has expired. Reload to see it.",
      fields: null,
    });
    expect(await rejections()).toEqual([]);
  });

  it('409s a page showing an older pick, and records nothing', async () => {
    await put();
    const response = await reject('j1', 'P1', USER_A, { version: 2 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('newer draft') });
    expect(await rejections()).toEqual([]);
  });

  it('400s a body without a JSON object, and records nothing', async () => {
    await put();
    expect((await reject('j1', 'P1', USER_A, ['P1'])).status).toBe(400);
    expect(await rejections()).toEqual([]);
  });

  it('409s once the evidence is hidden', async () => {
    await put('run-1', 29);
    expect((await reject('j1', 'P1')).status).toBe(409);
    expect(await rejections()).toEqual([]);
  });

  it('409s a pick with no research run', async () => {
    await put(null);
    expect((await reject('j1', 'P1')).status).toBe(409);
  });

  it('409s a job with no pick yet', async () => {
    await seedJob({ ...A_JOB, id: 'j1', state: 'PICK' });
    expect((await reject('j1', 'P1')).status).toBe(409);
  });
});

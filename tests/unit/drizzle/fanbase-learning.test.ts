// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { sql, type SQL } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Database, type Tx } from '#lib/server/core/db.js';
import { approveGuide } from '#lib/server/artist/guides.js';
import { withIdentity } from '#lib/server/core/identity.js';
import { jobRow } from '#lib/server/jobs/rows.js';
import { seed, truncate } from '../../helpers/db';
import {
  approvedGuide,
  ARTIST_A,
  ARTIST_C,
  jobDoc,
  pendingProposal,
  USER_A,
  USER_C,
  USERS,
} from '../../helpers/pipeline';

type Row = Record<string, unknown>;
const DAY_MS = 24 * 60 * 60 * 1000;
const ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const BRAND = { statement: 'Plain.', keep: [], fix: [], drop: [] };
const INFLUENCE = { sound: 1, feel: 0, wording: 0, discovery: 4, structure: 4 };
const FUNCTIONS = [
  'soundboard_influence_ok',
  'soundboard_research_claim',
  'soundboard_caller_artist',
  'soundboard_run_artist',
  'soundboard_save_research',
  'soundboard_save_outcomes',
  'soundboard_reject_peer',
  'soundboard_refresh_rejections',
  'soundboard_save_influence',
  'soundboard_forget_outcomes',
];
const ago = (ms: number) => new Date(Date.now() - ms);
const JUST_FRESH = 29 * DAY_MS - 60_000;
const EXPIRED = 29 * DAY_MS;

async function rows(tx: Database | Tx, statement: SQL): Promise<Row[]> {
  return ((await tx.execute(statement)) as { rows: Row[] }).rows;
}

function asUser<T>(uid: string, operation: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`set local role soundboard_app`);
    await tx.execute(sql`select set_config('app.user_sub', ${uid}, true)`);
    return operation(tx);
  });
}

function asCleanup<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`set local role soundboard_cleanup`);
    return operation(tx);
  });
}

/** Rejects with the Postgres error code `code`. */
async function fails(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(
    operation.catch((error: unknown) => {
      throw error instanceof Error && error.cause ? error.cause : error;
    }),
  ).rejects.toMatchObject({ code });
}

const run = (jobId: string, id: string, ownerUid: string, artistId: string) => ({
  jobId,
  id,
  ownerUid,
  artistId,
  stage: 'learn' as const,
});

const outcome = (artistId: string, videoId: string, retrievedAt = new Date()) => ({
  artistId,
  videoId,
  retrievedAt,
  publishedAt: new Date('2026-09-01T00:00:00Z'),
  requestedStart: '2026-08-31',
  requestedEnd: '2026-09-27',
  coverage: 'complete' as const,
  metrics: { views: 10, subscribersGained: 1, subscribersLost: 0 },
  live: { title: 't', description: 'd', tags: [] },
});

const shared = (uid: string) =>
  db().execute(
    sql`update connections set scopes = array_append(scopes, ${ANALYTICS}) where uid = ${uid}`,
  );

/** Gives run `id` the live claim `token` (or an expired one). */
const claimRun = (id: string, token: string, live = true) =>
  db().execute(
    sql`update research_runs set claim_token = ${token},
      claim_until = now() + ${live ? sql`interval '3 minutes'` : sql`interval '-1 minute'`}
      where id = ${id}`,
  );

const saveResearch = (tx: Tx, runId: string, token: string, at: Date, evidence: unknown = {}) =>
  tx.execute(
    sql`select public.soundboard_save_research(${runId}, ${token}, ${at.toISOString()}::timestamptz, ${JSON.stringify(evidence)}::jsonb)`,
  );

const OUTCOME_ROW = {
  videoId: 'v1',
  publishedAt: '2026-09-01T00:00:00Z',
  requestedStart: '2026-08-31',
  requestedEnd: '2026-09-27',
  coverage: 'open',
  metrics: { views: 5, subscribersGained: null, subscribersLost: null },
  live: { title: 'Song', description: 'Out now.', tags: [] },
  differsFromApproved: null,
};

const saveOutcomes = (tx: Tx, runId: string, token: string, grantAt: Date) =>
  rows(
    tx,
    sql`select public.soundboard_save_outcomes(${runId}, ${token}, ${grantAt.toISOString()}::timestamptz, ${JSON.stringify([OUTCOME_ROW])}::jsonb) as n`,
  );

const grantOf = async (uid: string) =>
  new Date(
    (await rows(db(), sql`select updated_at from connections where uid = ${uid}`))[0]!
      .updated_at as string,
  );

const count = async (table: string) =>
  (await rows(db(), sql`select count(*)::int as n from ${sql.identifier(table)}`))[0]!.n;

beforeEach(async () => {
  await truncate();
  await seed({
    ...USERS,
    jobs: [
      jobRow(jobDoc({ id: 'a', ownerUid: USER_A.uid, artistId: ARTIST_A.id })),
      jobRow(jobDoc({ id: 'c', ownerUid: USER_C.uid, artistId: ARTIST_C.id })),
    ],
    researchRuns: [
      run('a', 'run-a', USER_A.uid, ARTIST_A.id),
      run('c', 'run-c', USER_C.uid, ARTIST_C.id),
    ],
    jobResearch: [
      { runId: 'run-a', jobId: 'a', retrievedAt: new Date(), evidence: { peers: [] } },
      { runId: 'run-c', jobId: 'c', retrievedAt: new Date(), evidence: { peers: [] } },
    ],
    artistOutcomes: [outcome(ARTIST_A.id, 'va'), outcome(ARTIST_C.id, 'vc')],
    peerRejections: [
      { artistId: ARTIST_A.id, channelId: 'UCx', retrievedAt: new Date() },
      { artistId: ARTIST_C.id, channelId: 'UCy', retrievedAt: new Date() },
    ],
  });
  await shared(USER_A.uid);
  await shared(USER_C.uid);
});

describe('fanbase learning migration', () => {
  const journal = async () =>
    (
      JSON.parse(await readFile(resolve('drizzle/meta/_journal.json'), 'utf8')) as {
        entries: { tag: string }[];
      }
    ).entries.map((entry) => entry.tag);

  async function apply(pglite: PGlite, tag: string): Promise<void> {
    const file = await readFile(resolve('drizzle', `${tag}.sql`), 'utf8');
    await pglite.transaction(async (tx) => {
      for (const statement of file.split('--> statement-breakpoint')) {
        if (statement.trim()) await tx.exec(statement);
      }
    });
  }

  it('applies on top of 005 and leaves an approved brand row as it was, influence null', async () => {
    const tags = await journal();
    const tag = '0007_fanbase_learning';
    const pglite = new PGlite();
    for (const earlier of tags.slice(0, tags.indexOf(tag))) await apply(pglite, earlier);
    await pglite.query(
      `insert into artist_guides (artist_id, kind, status, body, sources, proposed_at, approved_at)
        values ('flr', 'brand', 'approved', $1, $2, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')`,
      [BRAND, { uploads: 3, drafts: 0, edits: 0, approvals: 0, carriedOver: true }],
    );
    const before = (await pglite.query<Row>(`select * from artist_guides order by id`)).rows;
    await apply(pglite, tag);
    const after = (await pglite.query<Row>(`select * from artist_guides order by id`)).rows;
    expect(after).toEqual(before.map((row) => ({ ...row, influence: null })));
  });

  it('pins every function search path, temp schema last, and grants PUBLIC nothing', async () => {
    const found = await rows(
      db(),
      sql`select p.proname, p.prosecdef, p.proconfig from pg_proc p
        where p.proname in (${sql.join(
          FUNCTIONS.map((f) => sql`${f}`),
          sql`, `,
        )}) order by p.proname`,
    );
    expect(found.map((f) => f.proname)).toEqual([...FUNCTIONS].sort());
    for (const f of found) {
      expect(f.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
      expect(f.prosecdef).toBe(f.proname !== 'soundboard_influence_ok');
    }
    expect(
      await rows(
        db(),
        sql`select p.proname from pg_proc p, lateral aclexplode(p.proacl) acl
          where p.proname in (${sql.join(
            FUNCTIONS.map((f) => sql`${f}`),
            sql`, `,
          )}) and acl.grantee = 0`,
      ),
    ).toEqual([]);
  });

  it('forces RLS on every new table', async () => {
    expect(
      await rows(
        db(),
        sql`select relname, relrowsecurity, relforcerowsecurity from pg_class
          where relname in ('research_runs', 'job_research', 'artist_outcomes', 'peer_rejections')
          order by relname`,
      ),
    ).toEqual(
      ['artist_outcomes', 'job_research', 'peer_rejections', 'research_runs'].map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
  });
});

describe('own rows only', () => {
  it.each([
    ['research_runs', 'job_id', 'a'],
    ['job_research', 'run_id', 'run-a'],
    ['artist_outcomes', 'video_id', 'va'],
    ['peer_rejections', 'channel_id', 'UCx'],
  ])('shows %s only for the caller', async (table, column, own) => {
    expect(
      await asUser(USER_A.uid, (tx) =>
        rows(tx, sql`select ${sql.identifier(column)} as v from ${sql.identifier(table)}`),
      ),
    ).toEqual([{ v: own }]);
  });

  it("changes nothing of another user's run and refuses direct evidence writes", async () => {
    expect(
      await asUser(USER_A.uid, (tx) =>
        rows(tx, sql`update research_runs set stage = 'done' where id = 'run-c' returning id`),
      ),
    ).toEqual([]);
    expect(
      await asUser(USER_A.uid, (tx) =>
        rows(tx, sql`delete from research_runs where id = 'run-c' returning id`),
      ),
    ).toEqual([]);
    for (const statement of [
      sql`insert into job_research (run_id, job_id, retrieved_at, evidence) values ('x', 'a', now(), '{}')`,
      sql`delete from artist_outcomes`,
      sql`insert into peer_rejections (artist_id, channel_id, retrieved_at) values ('flr', 'UCz', now())`,
      sql`update artist_guides set influence = '{}'`,
      sql`update research_runs set owner_uid = ${USER_C.uid}`,
    ]) {
      await fails(
        asUser(USER_A.uid, (tx) => tx.execute(statement)),
        '42501',
      );
    }
  });

  it("refuses a run for another user's job or under an artist that isn't the caller's", async () => {
    await db().execute(sql`delete from research_runs`);
    await fails(
      asUser(USER_A.uid, (tx) =>
        tx.execute(sql`insert into research_runs (job_id, owner_uid, artist_id, stage)
          values ('c', ${USER_A.uid}, ${ARTIST_A.id}, 'learn')`),
      ),
      '42501',
    );
    await fails(
      asUser(USER_A.uid, (tx) =>
        tx.execute(sql`insert into research_runs (job_id, owner_uid, artist_id, stage)
          values ('a', ${USER_A.uid}, ${ARTIST_C.id}, 'learn')`),
      ),
      '42501',
    );
    await asUser(USER_A.uid, (tx) =>
      tx.execute(sql`insert into research_runs (job_id, owner_uid, artist_id, stage)
        values ('a', ${USER_A.uid}, ${ARTIST_A.id}, 'learn')`),
    );
    const [mine] = await rows(db(), sql`select id from research_runs`);
    expect(mine?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never lets the app role pick or change a run id', async () => {
    await db().execute(sql`delete from research_runs where job_id = 'a'`);
    await fails(
      asUser(USER_A.uid, (tx) =>
        tx.execute(sql`insert into research_runs (job_id, id, owner_uid, artist_id, stage)
          values ('a', 'run-c-old', ${USER_A.uid}, ${ARTIST_A.id}, 'learn')`),
      ),
      '42501',
    );
    await db().execute(sql`insert into research_runs (job_id, id, owner_uid, artist_id, stage)
      values ('a', 'run-a', ${USER_A.uid}, ${ARTIST_A.id}, 'learn')`);
    for (const column of [sql`id = 'run-c-old'`, sql`started_at = now()`]) {
      await fails(
        asUser(USER_A.uid, (tx) => tx.execute(sql`update research_runs set ${column}`)),
        '42501',
      );
    }
    expect(await rows(db(), sql`select id from research_runs where job_id = 'a'`)).toEqual([
      { id: 'run-a' },
    ]);
  });

  it("never overwrites another job's evidence through a run that shares its id", async () => {
    // A's replaced run left evidence under `run-old`; C's run collides with that id.
    await db().execute(sql`insert into job_research (run_id, job_id, retrieved_at, evidence)
      values ('run-old', 'a', now(), '{"query":"a"}'::jsonb)`);
    await db().execute(sql`update research_runs set id = 'run-old' where job_id = 'c'`);
    await claimRun('run-old', 'tok-c');
    await fails(
      asUser(USER_C.uid, (tx) => saveResearch(tx, 'run-old', 'tok-c', new Date(), { query: 'c' })),
      '42501',
    );
    expect(
      await rows(db(), sql`select job_id, evidence from job_research where run_id = 'run-old'`),
    ).toEqual([{ job_id: 'a', evidence: { query: 'a' } }]);
  });
});

describe('29-day expiry', () => {
  it.each([
    ['job_research', 'retrieved_at'],
    ['artist_outcomes', 'retrieved_at'],
    ['peer_rejections', 'retrieved_at'],
  ])('shows %s a minute before 29 days and hides it at 29 days', async (table) => {
    const visible = async () =>
      (await asUser(USER_A.uid, (tx) => rows(tx, sql`select 1 from ${sql.identifier(table)}`)))
        .length;
    await db().execute(
      sql`update ${sql.identifier(table)} set retrieved_at = ${ago(JUST_FRESH).toISOString()}::timestamptz`,
    );
    expect(await visible()).toBe(1);
    await db().execute(
      sql`update ${sql.identifier(table)} set retrieved_at = ${ago(EXPIRED).toISOString()}::timestamptz`,
    );
    expect(await visible()).toBe(0);
  });

  it('hides outcomes once sharing ends, before the trigger deletes them', async () => {
    const visible = () =>
      asUser(USER_A.uid, (tx) => rows(tx, sql`select video_id from artist_outcomes`));
    expect(await visible()).toEqual([{ video_id: 'va' }]);
    await db().execute(sql`alter table connections disable trigger connections_forget_outcomes`);
    try {
      await db().execute(
        sql`update connections set scopes = array['openid'] where uid = ${USER_A.uid}`,
      );
      expect(await visible()).toEqual([]);
      expect(await count('artist_outcomes')).toBe(2);
    } finally {
      await db().execute(sql`alter table connections enable trigger connections_forget_outcomes`);
    }
  });
});

describe('claim-guarded research writes', () => {
  it('saves evidence under the live claim and keeps the first retrieval time', async () => {
    await claimRun('run-a', 't1');
    await db().execute(sql`delete from job_research`);
    const first = ago(60_000);
    await asUser(USER_A.uid, (tx) => saveResearch(tx, 'run-a', 't1', first, { n: 1 }));
    await asUser(USER_A.uid, (tx) => saveResearch(tx, 'run-a', 't1', new Date(), { n: 2 }));
    const [saved] = await rows(db(), sql`select job_id, retrieved_at, evidence from job_research`);
    expect(saved).toMatchObject({ job_id: 'a', evidence: { n: 2 } });
    expect(new Date(saved!.retrieved_at as string).getTime()).toBe(first.getTime());
  });

  it.each([
    ['a wrong token', async () => claimRun('run-a', 't1'), USER_A.uid, 'run-a', 'wrong'],
    ['an expired claim', async () => claimRun('run-a', 't1', false), USER_A.uid, 'run-a', 't1'],
    ["another user's run", async () => claimRun('run-c', 't1'), USER_A.uid, 'run-c', 't1'],
    [
      'a discarded job',
      async () => {
        await claimRun('run-a', 't1');
        await db().execute(sql`update jobs set state = 'DISCARDED' where id = 'a'`);
      },
      USER_A.uid,
      'run-a',
      't1',
    ],
  ])('refuses %s with 55000 and writes nothing', async (_name, setup, uid, runId, token) => {
    await setup();
    const before = await rows(db(), sql`select * from job_research order by run_id`);
    await fails(
      asUser(uid, (tx) => saveResearch(tx, runId, token, new Date(), { forged: true })),
      '55000',
    );
    await fails(
      asUser(uid, (tx) => saveOutcomes(tx, runId, token, new Date())),
      '55000',
    );
    await fails(
      asUser(uid, (tx) =>
        tx.execute(
          sql`select public.soundboard_refresh_rejections(${runId}, ${token}, '{}', array['UCx'])`,
        ),
      ),
      '55000',
    );
    expect(await rows(db(), sql`select * from job_research order by run_id`)).toEqual(before);
    expect(await count('peer_rejections')).toBe(2);
  });

  it.each([
    ['in the future', new Date(Date.now() + 60 * 60_000)],
    ['already expired', ago(EXPIRED)],
  ])('refuses a retrieval time %s', async (_name, at) => {
    await claimRun('run-a', 't1');
    await fails(
      asUser(USER_A.uid, (tx) => saveResearch(tx, 'run-a', 't1', at)),
      '22023',
    );
  });

  it('refreshes kept rejections and deletes gone ones for the caller only', async () => {
    await db().execute(
      sql`update peer_rejections set retrieved_at = ${ago(DAY_MS).toISOString()}::timestamptz`,
    );
    await db().execute(sql`insert into peer_rejections values ('flr', 'UCgone', now())`);
    await claimRun('run-a', 't1');
    await asUser(USER_A.uid, (tx) =>
      tx.execute(
        sql`select public.soundboard_refresh_rejections('run-a', 't1', array['UCx', 'UCy'], array['UCgone', 'UCy'])`,
      ),
    );
    const left = await rows(
      db(),
      sql`select artist_id, channel_id, retrieved_at > now() - interval '1 minute' as fresh
      from peer_rejections order by channel_id`,
    );
    expect(left).toEqual([
      { artist_id: 'flr', channel_id: 'UCx', fresh: true },
      { artist_id: 'artist-c', channel_id: 'UCy', fresh: false },
    ]);
  });
});

describe('outcome saves need the live analytics grant', () => {
  it('replaces the caller artist row for each saved video', async () => {
    await claimRun('run-a', 't1');
    await db()
      .execute(sql`insert into artist_outcomes select 'flr', 'v1', now() - interval '30 days',
      published_at, requested_start, requested_end, coverage, metrics, live from artist_outcomes where video_id = 'va'`);
    const grantAt = await grantOf(USER_A.uid);
    const [saved] = await asUser(USER_A.uid, (tx) => saveOutcomes(tx, 'run-a', 't1', grantAt));
    expect(saved).toEqual({ n: 1 });
    expect(
      await rows(
        db(),
        sql`select video_id, coverage, metrics, retrieved_at > now() - interval '1 minute' as fresh
        from artist_outcomes where artist_id = 'flr' order by video_id`,
      ),
    ).toEqual([
      { video_id: 'v1', coverage: 'open', metrics: OUTCOME_ROW.metrics, fresh: true },
      { video_id: 'va', coverage: 'complete', metrics: outcome('', '').metrics, fresh: true },
    ]);
  });

  it('refuses with 42501 after the caller relinks to another artist mid-run', async () => {
    await claimRun('run-a', 't1');
    const grantAt = await grantOf(USER_A.uid);
    await db().execute(sql`insert into artists (id, name) values ('artist-new', 'New Artist')`);
    await db().execute(sql`update users set artist_id = 'artist-new' where uid = ${USER_A.uid}`);
    await fails(
      asUser(USER_A.uid, (tx) => saveOutcomes(tx, 'run-a', 't1', grantAt)),
      '42501',
    );
    await fails(
      asUser(USER_A.uid, (tx) =>
        tx.execute(
          sql`select public.soundboard_refresh_rejections('run-a', 't1', '{}', array['UCx'])`,
        ),
      ),
      '42501',
    );
    expect(await count('artist_outcomes')).toBe(2);
    expect(await count('peer_rejections')).toBe(2);
  });

  it.each([
    [
      'revoked',
      sql`update connections set status = 'revoked', token_ciphertext = null where uid = ${USER_A.uid}`,
    ],
    [
      'missing the scope',
      sql`update connections set scopes = array['openid'] where uid = ${USER_A.uid}`,
    ],
    ['replaced since', sql`update connections set updated_at = now() where uid = ${USER_A.uid}`],
  ])('refuses with 28000 when the grant is %s', async (_name, change) => {
    await claimRun('run-a', 't1');
    const grantAt = await grantOf(USER_A.uid);
    await db().execute(change);
    const before = await rows(db(), sql`select * from artist_outcomes order by video_id`);
    await fails(
      asUser(USER_A.uid, (tx) => saveOutcomes(tx, 'run-a', 't1', grantAt)),
      '28000',
    );
    expect(await rows(db(), sql`select * from artist_outcomes order by video_id`)).toEqual(before);
  });
});

describe('peer rejections', () => {
  it('inserts or refreshes for the caller artist only', async () => {
    await db().execute(
      sql`update peer_rejections set retrieved_at = ${ago(DAY_MS).toISOString()}::timestamptz`,
    );
    await asUser(USER_A.uid, (tx) => tx.execute(sql`select public.soundboard_reject_peer('UCy')`));
    await asUser(USER_A.uid, (tx) => tx.execute(sql`select public.soundboard_reject_peer('UCx')`));
    expect(
      await rows(
        db(),
        sql`select artist_id, channel_id, retrieved_at > now() - interval '1 minute' as fresh
        from peer_rejections order by artist_id, channel_id`,
      ),
    ).toEqual([
      { artist_id: 'artist-c', channel_id: 'UCy', fresh: false },
      { artist_id: 'flr', channel_id: 'UCx', fresh: true },
      { artist_id: 'flr', channel_id: 'UCy', fresh: true },
    ]);
  });

  it('refuses a user without a profile and an empty channel', async () => {
    await fails(
      asUser('uid-b', (tx) => tx.execute(sql`select public.soundboard_reject_peer('UCz')`)),
      '42501',
    );
    await fails(
      asUser(USER_A.uid, (tx) => tx.execute(sql`select public.soundboard_reject_peer('')`)),
      '22023',
    );
  });
});

describe('saved sliders', () => {
  const save = (uid: string, value: unknown) =>
    asUser(uid, (tx) =>
      rows(tx, sql`select public.soundboard_save_influence(${JSON.stringify(value)}::jsonb) as n`),
    );

  it('updates only the approved brand row and none of its other columns', async () => {
    await seed({
      artistGuides: [
        approvedGuide(ARTIST_C.id, 'brand', BRAND),
        pendingProposal(ARTIST_C.id, 'brand', BRAND),
      ],
    });
    const before = await rows(
      db(),
      sql`select * from artist_guides where artist_id = 'artist-c' order by id`,
    );
    expect(await save(USER_C.uid, INFLUENCE)).toEqual([{ n: 1 }]);
    const after = await rows(
      db(),
      sql`select * from artist_guides where artist_id = 'artist-c' order by id`,
    );
    expect(after).toEqual(
      before.map((row) => ({ ...row, influence: row.status === 'approved' ? INFLUENCE : null })),
    );
  });

  it('returns 0 without an approved brand guide', async () => {
    expect(await save(USER_A.uid, INFLUENCE)).toEqual([{ n: 0 }]);
  });

  it.each([
    ['4 keys', { sound: 1, feel: 0, wording: 0, discovery: 4 }],
    ['6 keys', { ...INFLUENCE, extra: 1 }],
    ['5', { ...INFLUENCE, sound: 5 }],
    ['2.5', { ...INFLUENCE, sound: 2.5 }],
    ['-1', { ...INFLUENCE, sound: -1 }],
    ['"2"', { ...INFLUENCE, sound: '2' }],
    ['an array', [1, 0, 0, 4, 4]],
    ['a renamed key', { ...INFLUENCE, sound: undefined, tone: 1 }],
  ])('refuses %s', async (_name, value) => {
    await seed({ artistGuides: [approvedGuide(ARTIST_C.id, 'brand', BRAND)] });
    await fails(save(USER_C.uid, value), '23514');
  });

  it.each([
    ['a proposed row', pendingProposal(ARTIST_C.id, 'brand', BRAND)],
    ['a voice row', approvedGuide(ARTIST_C.id, 'voice', { rules: ['Plain.'] })],
  ])('refuses influence on %s', async (_name, guide) => {
    await seed({ artistGuides: [guide] });
    await fails(
      db().execute(
        sql`update artist_guides set influence = ${JSON.stringify(INFLUENCE)}::jsonb where artist_id = 'artist-c'`,
      ),
      '23514',
    );
  });

  it("keeps the sliders through 005's approve upsert", async () => {
    await seed({
      artistGuides: [
        { ...approvedGuide(ARTIST_C.id, 'brand', BRAND), influence: INFLUENCE },
        pendingProposal(ARTIST_C.id, 'brand', { ...BRAND, statement: 'New.' }),
      ],
    });
    const [pending] = await rows(db(), sql`select id from artist_guides where status = 'proposed'`);
    await withIdentity(USER_C.uid, () =>
      approveGuide(ARTIST_C.id, 'brand', pending!.id as number, { ...BRAND, statement: 'New.' }),
    );
    expect(
      await rows(
        db(),
        sql`select body->>'statement' as s, influence from artist_guides where artist_id = 'artist-c'`,
      ),
    ).toEqual([{ s: 'New.', influence: INFLUENCE }]);
  });
});

describe('forgetting outcomes when sharing ends', () => {
  const left = () => rows(db(), sql`select artist_id from artist_outcomes order by artist_id`);

  it.each([
    ['Disconnect', sql`delete from connections where uid = ${USER_A.uid}`],
    [
      'a revocation',
      sql`update connections set status = 'revoked', token_ciphertext = null where uid = ${USER_A.uid}`,
    ],
    [
      'a reconnect without the scope',
      sql`update connections set scopes = array['openid'], updated_at = now() where uid = ${USER_A.uid}`,
    ],
    [
      'a reconnect to another channel',
      sql`update connections set channel_id = 'UCother', updated_at = now() where uid = ${USER_A.uid}`,
    ],
  ])("deletes the artist's outcomes on %s and leaves other artists'", async (_name, change) => {
    await asUser(USER_A.uid, (tx) => tx.execute(change));
    expect(await left()).toEqual([{ artist_id: ARTIST_C.id }]);
  });

  it('deletes nothing on a reconnect that keeps the scope', async () => {
    await asUser(USER_A.uid, (tx) =>
      tx.execute(sql`update connections set updated_at = now() where uid = ${USER_A.uid}`),
    );
    expect(await left()).toEqual([{ artist_id: ARTIST_C.id }, { artist_id: ARTIST_A.id }]);
  });
});

describe('cleanup role', () => {
  beforeEach(async () => {
    for (const table of ['job_research', 'artist_outcomes', 'peer_rejections']) {
      await db().execute(
        sql`update ${sql.identifier(table)} set retrieved_at = ${ago(EXPIRED).toISOString()}::timestamptz
          where ${sql.raw(table === 'job_research' ? `run_id = 'run-a'` : `artist_id = 'flr'`)}`,
      );
    }
  });

  it.each([
    ['job_research', 'run_id', 'run-a'],
    ['artist_outcomes', 'video_id', 'va'],
    ['peer_rejections', 'channel_id', 'UCx'],
  ])('sees and deletes only expired %s rows', async (table, column, expired) => {
    await asCleanup(async (tx) => {
      expect(
        await rows(tx, sql`select ${sql.identifier(column)} as v from ${sql.identifier(table)}`),
      ).toEqual([{ v: expired }]);
      expect(
        await rows(
          tx,
          sql`delete from ${sql.identifier(table)} returning ${sql.identifier(column)} as v`,
        ),
      ).toEqual([{ v: expired }]);
    });
    expect(await count(table)).toBe(1);
  });

  it.each([
    sql`select evidence from job_research`,
    sql`select metrics from artist_outcomes`,
    sql`select live from artist_outcomes`,
    sql`select * from research_runs`,
  ])('never reads stored YouTube data or run state', async (statement) => {
    await fails(
      asCleanup((tx) => tx.execute(statement)),
      '42501',
    );
  });
});

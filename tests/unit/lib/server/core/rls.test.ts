// @vitest-environment node
import { eq, sql, type SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, query, type Database, type Tx } from '#lib/server/core/db.js';
import { withIdentity } from '#lib/server/core/identity.js';
import {
  artistGuides,
  artistMemory,
  artists,
  connections,
  guideClaims,
  jobAudience,
  jobs,
  users,
} from '#lib/server/core/schema.js';
import { artistJob, writeFeedback, type Feedback } from '#lib/server/artist/memory.js';
import { readAudience, saveAudience } from '#lib/server/jobs/audience.js';
import { markFinalChunk, markUploadStarted } from '#lib/server/jobs/jobs.js';
import { jobRow } from '#lib/server/jobs/rows.js';
import type { AudienceEvidence } from '#lib/server/pipeline/hashtags.js';
import { seed, truncate } from '../../../../helpers/db';
import {
  approvedGuide,
  ARTIST_A,
  ARTIST_C,
  jobDoc,
  pendingProposal,
  USER_A,
  USER_B,
  USER_C,
  USERS,
} from '../../../../helpers/pipeline';

const DAY_MS = 24 * 60 * 60 * 1000;
const evidence = (retrievedAt = Date.now()): AudienceEvidence => ({
  retrievedAt,
  query: 'rock music video',
  candidateLists: [],
  top: [],
});
const A_JOB = jobDoc({ id: 'a', ownerUid: USER_A.uid, artistId: USER_A.artistId });
const B_JOB = jobDoc({ id: 'b', ownerUid: USER_B.uid, artistId: null });
const TABLES = [
  'artists',
  'users',
  'connections',
  'jobs',
  'job_audience',
  'artist_memory',
  'artist_guides',
  'guide_claims',
] as const;

function restricted<T>(
  role: 'app' | 'cleanup',
  uid: string | undefined,
  operation: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(
      role === 'app' ? sql`set local role soundboard_app` : sql`set local role soundboard_cleanup`,
    );
    await tx.execute(sql`select set_config('app.user_sub', ${uid ?? ''}, true)`);
    return operation(tx);
  });
}

async function rows(tx: Database | Tx, statement: SQL): Promise<Record<string, unknown>[]> {
  return ((await tx.execute(statement)) as { rows: Record<string, unknown>[] }).rows;
}

async function denied(operation: Promise<unknown>): Promise<void> {
  await expect(
    operation.catch((error: unknown) => {
      throw error instanceof Error && error.cause ? error.cause : error;
    }),
  ).rejects.toMatchObject({ code: '42501' });
}

beforeEach(async () => {
  await truncate();
  const fresh = evidence();
  const expired = evidence(Date.now() - 31 * DAY_MS);
  await seed({
    ...USERS,
    connections: [
      ...USERS.connections,
      {
        uid: USER_B.uid,
        status: 'revoked',
        scopes: [],
        tokenCiphertext: null,
        updatedAt: new Date(),
      },
    ],
    jobs: [jobRow(A_JOB), jobRow(B_JOB), jobRow({ ...A_JOB, id: 'a-old' })],
    jobAudience: [
      { jobId: 'a', retrievedAt: new Date(fresh.retrievedAt), evidence: fresh },
      { jobId: 'b', retrievedAt: new Date(fresh.retrievedAt), evidence: fresh },
      { jobId: 'a-old', retrievedAt: new Date(expired.retrievedAt), evidence: expired },
    ],
    artistMemory: [
      { artistId: 'flr', kind: 'fact', key: 'name', data: { value: 'Flies Like Robots' } },
      { artistId: 'artist-c', kind: 'fact', key: 'name', data: { value: 'Test Artist' } },
    ],
  });
});

describe('runtime role isolation', () => {
  it('uses a non-owner role without privileged role attributes', async () => {
    const [role] = await rows(
      db(),
      sql`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
        from pg_roles where rolname = 'soundboard_app'`,
    );
    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
    expect(
      await rows(
        db(),
        sql`select c.relname from pg_class c join pg_roles r on r.oid = c.relowner
          where r.rolname = 'soundboard_app' and c.relname in
          ('users', 'connections', 'jobs', 'job_audience', 'artist_memory')`,
      ),
    ).toEqual([]);
  });

  it.each(TABLES)('returns no %s rows without a verified subject', async (table) => {
    expect(
      await restricted('app', undefined, (tx) =>
        rows(tx, sql`select * from ${sql.identifier(table)}`),
      ),
    ).toEqual([]);
  });

  it.each([USER_A.uid, USER_B.uid])(
    'limits all ordinary table reads to subject %s',
    async (uid) => {
      const own = uid === USER_A.uid ? 'a' : 'b';
      await withIdentity(uid, () =>
        query(async (tx) => {
          expect(await rows(tx, sql`select uid from users`)).toEqual([{ uid }]);
          expect(await rows(tx, sql`select uid from connections`)).toEqual([{ uid }]);
          expect(await rows(tx, sql`select id from jobs order by id`)).toEqual(
            own === 'a' ? [{ id: 'a' }, { id: 'a-old' }] : [{ id: 'b' }],
          );
          expect(await rows(tx, sql`select job_id from job_audience`)).toEqual([{ job_id: own }]);
          expect(await rows(tx, sql`select job_id from job_audience_fresh`)).toEqual([
            { job_id: own },
          ]);
          expect(await rows(tx, sql`select artist_id from artist_memory`)).toEqual(
            own === 'a' ? [{ artist_id: 'flr' }] : [],
          );
          expect(await rows(tx, sql`select artist_id from artist_guides`)).toEqual(
            own === 'a' ? [{ artist_id: 'flr' }] : [],
          );
        }),
      );
    },
  );

  it('resets the transaction subject and role after a failed restricted operation', async () => {
    await denied(
      restricted('app', USER_A.uid, (tx) =>
        tx.insert(jobs).values(jobRow({ ...B_JOB, id: 'forged' })),
      ),
    );
    expect(await rows(db(), sql`select current_setting('role') as role`)).toEqual([
      { role: 'none' },
    ]);
    expect(await restricted('app', undefined, (tx) => rows(tx, sql`select id from jobs`))).toEqual(
      [],
    );
  });

  it('keeps sequential A to B to A operations isolated in the same process', async () => {
    for (const uid of [USER_A.uid, USER_B.uid, USER_A.uid]) {
      expect(
        await withIdentity(uid, () => query((tx) => rows(tx, sql`select uid from users`))),
      ).toEqual([{ uid }]);
    }
  });

  it('rejects ordinary inserts without a verified subject', async () => {
    await denied(
      restricted('app', undefined, (tx) =>
        tx.insert(jobs).values(jobRow({ ...A_JOB, id: 'missing-subject' })),
      ),
    );
    await denied(
      restricted('app', undefined, (tx) =>
        tx
          .insert(connections)
          .values({ uid: USER_A.uid, status: 'revoked', scopes: [], updatedAt: new Date() }),
      ),
    );
    await denied(
      restricted('app', undefined, (tx) =>
        tx.insert(artistMemory).values({ artistId: 'flr', kind: 'feedback', data: {} }),
      ),
    );
  });

  it.each(TABLES)('denies %s reads after the bound user is revoked', async (table) => {
    await db().update(users).set({ active: false }).where(eq(users.uid, USER_A.uid));

    expect(
      await restricted('app', USER_A.uid, (tx) =>
        rows(tx, sql`select * from ${sql.identifier(table)}`),
      ),
    ).toEqual([]);
  });

  it('denies schema creation to the runtime role', async () => {
    await denied(
      restricted('app', USER_A.uid, (tx) =>
        tx.execute(sql`create table public.runtime_escalation (id text)`),
      ),
    );
  });
});

describe('job and connection writes', () => {
  it('allows own job and connection mutations without changing another user', async () => {
    await restricted('app', USER_A.uid, async (tx) => {
      expect(
        await tx.update(jobs).set({ state: 'REVIEW' }).where(eq(jobs.id, 'a')).returning(),
      ).toHaveLength(1);
      expect(
        await tx
          .update(connections)
          .set({ channelTitle: 'Updated title' })
          .where(eq(connections.uid, USER_A.uid))
          .returning(),
      ).toHaveLength(1);
      expect(
        await tx.update(jobs).set({ state: 'FAILED' }).where(eq(jobs.id, 'b')).returning(),
      ).toEqual([]);
      expect(await tx.delete(jobs).where(eq(jobs.id, 'b')).returning()).toEqual([]);
      expect(
        await tx
          .update(connections)
          .set({ channelTitle: 'Stolen' })
          .where(eq(connections.uid, USER_B.uid))
          .returning(),
      ).toEqual([]);
      expect(
        await tx.delete(connections).where(eq(connections.uid, USER_B.uid)).returning(),
      ).toEqual([]);
    });

    expect(await db().select().from(jobs).where(eq(jobs.id, 'b'))).toMatchObject([
      { ownerUid: USER_B.uid, state: 'PREP' },
    ]);
    expect(
      await db().select().from(connections).where(eq(connections.uid, USER_B.uid)),
    ).toMatchObject([{ status: 'revoked', channelTitle: null }]);
  });

  it.each([
    { name: 'another owner', patch: { ownerUid: USER_B.uid, artistId: null } },
    { name: 'another artist', patch: { artistId: 'artist-c' } },
    { name: 'another owner parent', patch: { parentId: 'b' } },
  ])('rejects a job insert with $name', async ({ patch }) => {
    await denied(
      restricted('app', USER_A.uid, (tx) =>
        tx.insert(jobs).values(jobRow({ ...A_JOB, ...patch, id: 'forged' })),
      ),
    );
    expect(await db().select().from(jobs).where(eq(jobs.id, 'forged'))).toEqual([]);
  });

  it('allows an owned child with the linked artist', async () => {
    await restricted('app', USER_A.uid, async (tx) => {
      await tx.insert(jobs).values(jobRow({ ...A_JOB, id: 'child', parentId: 'a' }));
    });
    expect(await db().select().from(jobs).where(eq(jobs.id, 'child'))).toMatchObject([
      { ownerUid: USER_A.uid, artistId: 'flr', parentId: 'a' },
    ]);
  });

  it('preserves the owned parent artist on a child after the user is unlinked', async () => {
    await db().update(users).set({ artistId: null }).where(eq(users.uid, USER_A.uid));

    await restricted('app', USER_A.uid, async (tx) => {
      await tx.insert(jobs).values(jobRow({ ...A_JOB, id: 'child', parentId: 'a' }));
    });

    expect(await db().select().from(jobs).where(eq(jobs.id, 'child'))).toMatchObject([
      { ownerUid: USER_A.uid, artistId: 'flr', parentId: 'a' },
    ]);
  });

  it.each(['invented-artist', null])(
    'rejects a child whose artist %s differs from its owned parent',
    async (artistId) => {
      await db().update(users).set({ artistId: null }).where(eq(users.uid, USER_A.uid));

      await denied(
        restricted('app', USER_A.uid, (tx) =>
          tx.insert(jobs).values(jobRow({ ...A_JOB, id: 'child', artistId, parentId: 'a' })),
        ),
      );
      expect(await db().select().from(jobs).where(eq(jobs.id, 'child'))).toEqual([]);
    },
  );

  it.each(['id', 'owner_uid', 'artist_id', 'parent_id', 'created_at'])(
    'denies changing immutable job column %s',
    async (column) => {
      await denied(
        restricted('app', USER_A.uid, (tx) =>
          tx.execute(
            sql`update jobs set ${sql.identifier(column)} = ${sql.identifier(column)} where id = 'a'`,
          ),
        ),
      );
    },
  );

  it('denies inserting or rebinding another user connection', async () => {
    await denied(
      restricted('app', USER_A.uid, (tx) =>
        tx.insert(connections).values({
          uid: USER_B.uid,
          status: 'revoked',
          scopes: [],
          updatedAt: new Date(),
        }),
      ),
    );
    await denied(
      restricted('app', USER_A.uid, (tx) =>
        tx.execute(sql`update connections set uid = ${USER_B.uid} where uid = ${USER_A.uid}`),
      ),
    );
  });

  it.each(['active', 'artist_id', 'uid', 'email'])(
    'denies direct user %s updates',
    async (column) => {
      await denied(
        restricted('app', USER_A.uid, (tx) =>
          tx.execute(sql`update users set ${sql.identifier(column)} = ${sql.identifier(column)}`),
        ),
      );
    },
  );

  it('denies direct user insertion and deletion', async () => {
    await denied(
      restricted('app', USER_A.uid, (tx) =>
        tx.insert(users).values({ email: 'forged@example.test' }),
      ),
    );
    await denied(restricted('app', USER_A.uid, (tx) => tx.delete(users)));
  });
});

describe.each([
  { marker: 'uploadStartedAt', write: markUploadStarted },
  { marker: 'finalChunkAt', write: markFinalChunk },
] as const)('durable $marker marker', ({ marker, write }) => {
  it('keeps the first timestamp on repeated owned writes', async () => {
    await withIdentity(USER_A.uid, () => write('a'));
    const [first] = await db().select().from(jobs).where(eq(jobs.id, 'a'));
    expect(first![marker]).toBeInstanceOf(Date);

    await withIdentity(USER_A.uid, () => write('a'));
    const [second] = await db().select().from(jobs).where(eq(jobs.id, 'a'));
    expect(second![marker]).toEqual(first![marker]);
  });

  it.each(['revoked', 'foreign', 'missing'] as const)(
    'rejects a %s job instead of claiming the marker was durable',
    async (condition) => {
      if (condition === 'revoked') {
        await db().update(users).set({ active: false }).where(eq(users.uid, USER_A.uid));
      }
      const id = condition === 'foreign' ? 'b' : condition === 'missing' ? 'missing' : 'a';

      await expect(withIdentity(USER_A.uid, () => write(id))).rejects.toThrow(
        'Job is no longer writable.',
      );
      expect((await db().select().from(jobs)).every((job) => job[marker] === null)).toBe(true);
    },
  );
});

describe('artist ownership', () => {
  const feedback: Feedback = {
    kind: 'EDITED',
    jobId: 'a',
    songTitle: 'PeekaBoo',
    pickVersion: 1,
    at: 1,
    after: 'Edited title',
  };

  it('writes linked feedback to artist memory', async () => {
    await restricted('app', USER_A.uid, async (tx) => {
      expect(await artistJob(A_JOB, tx)).toBe(true);
      await writeFeedback(tx, [feedback], A_JOB);
    });
    expect(
      await db().select().from(artistMemory).where(eq(artistMemory.kind, 'feedback')),
    ).toMatchObject([{ artistId: 'flr', data: feedback }]);
  });

  it('keeps own jobs editable and stores feedback on the job after unlinking', async () => {
    await db().update(users).set({ artistId: null }).where(eq(users.uid, USER_A.uid));

    await restricted('app', USER_A.uid, async (tx) => {
      expect(await artistJob(A_JOB, tx)).toBe(false);
      expect(await tx.select().from(artistMemory)).toEqual([]);
      await writeFeedback(tx, [feedback], A_JOB);
    });
    expect(await db().select().from(jobs).where(eq(jobs.id, 'a'))).toMatchObject([
      { artistId: 'flr', feedback: [feedback] },
    ]);
    expect(await db().select().from(artistMemory).where(eq(artistMemory.kind, 'feedback'))).toEqual(
      [],
    );
  });

  it('rejects artist writes by an unlinked user and writes to another artist', async () => {
    for (const [uid, artistId] of [
      [USER_B.uid, 'flr'],
      [USER_A.uid, 'artist-c'],
    ] as const) {
      await denied(
        restricted('app', uid, (tx) =>
          tx.insert(artistMemory).values({ artistId, kind: 'feedback', data: feedback }),
        ),
      );
    }
    expect(await db().select().from(artistMemory).where(eq(artistMemory.kind, 'feedback'))).toEqual(
      [],
    );
  });
});

describe('audience retention', () => {
  it('hides the exact expiry boundary from the table and the invoker view', async () => {
    await db().transaction(async (tx) => {
      await tx
        .update(jobAudience)
        .set({ retrievedAt: sql`now() - interval '30 days'` })
        .where(eq(jobAudience.jobId, 'a'));
      await tx.execute(sql`set local role soundboard_app`);
      await tx.execute(sql`select set_config('app.user_sub', ${USER_A.uid}, true)`);

      expect(await tx.select().from(jobAudience)).toEqual([]);
      expect(await rows(tx, sql`select * from job_audience_fresh`)).toEqual([]);
    });
  });

  it('refreshes owned expired evidence and ignores older replacement data', async () => {
    const fresh = evidence();
    await restricted('app', USER_A.uid, async (tx) => {
      expect(await readAudience('a-old', tx)).toBeNull();
      await saveAudience(tx, 'a-old', fresh);
      await saveAudience(tx, 'a-old', { ...fresh, query: 'equal timestamp' });
      await saveAudience(tx, 'a-old', evidence(fresh.retrievedAt - DAY_MS));
      expect(await readAudience('a-old', tx)).toEqual(fresh);
    });
    expect(
      await db().select().from(jobAudience).where(eq(jobAudience.jobId, 'a-old')),
    ).toMatchObject([{ evidence: fresh }]);
  });

  it.each(['b', 'missing'])('denies evidence persistence for inaccessible job %s', async (id) => {
    const original = await db().select().from(jobAudience);
    await denied(restricted('app', USER_A.uid, (tx) => saveAudience(tx, id, evidence())));
    expect(await db().select().from(jobAudience)).toEqual(original);
  });

  it('denies evidence persistence without a subject and direct table writes', async () => {
    await denied(restricted('app', undefined, (tx) => saveAudience(tx, 'a', evidence())));
    await denied(
      restricted('app', USER_A.uid, (tx) =>
        tx
          .update(jobAudience)
          .set({ retrievedAt: new Date() })
          .where(eq(jobAudience.jobId, 'a-old')),
      ),
    );
    await denied(restricted('app', USER_A.uid, (tx) => tx.delete(jobAudience)));
  });
});

describe('cleanup privileges', () => {
  it('sees only expired identifiers and deletes only expired evidence', async () => {
    await restricted('cleanup', undefined, async (tx) => {
      expect(await rows(tx, sql`select job_id, retrieved_at from job_audience`)).toMatchObject([
        { job_id: 'a-old' },
      ]);
      expect(await rows(tx, sql`delete from job_audience returning job_id`)).toEqual([
        { job_id: 'a-old' },
      ]);
      expect(await rows(tx, sql`delete from job_audience returning job_id`)).toEqual([]);
    });
    expect(
      await db().select({ id: jobAudience.jobId }).from(jobAudience).orderBy(jobAudience.jobId),
    ).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(await db().select().from(jobs)).toHaveLength(3);
  });

  it.each([
    sql`select evidence from job_audience`,
    sql`select * from job_audience_fresh`,
    sql`select * from jobs`,
    sql`select * from users`,
    sql`select * from connections`,
    sql`select * from artist_memory`,
    sql`update job_audience set retrieved_at = now()`,
  ])('denies cleanup access outside expired identifiers and deletion (%#)', async (statement) => {
    await denied(restricted('cleanup', undefined, (tx) => tx.execute(statement)));
  });
});

describe('artist profiles', () => {
  const asUser = <T>(uid: string, operation: (tx: Tx) => Promise<T>) =>
    restricted('app', uid, operation);
  const create = (
    tx: Tx,
    name: string,
    bandcamp: string | null = null,
    contact: string | null = null,
  ) =>
    rows(tx, sql`select * from public.soundboard_create_artist(${name}, ${bandcamp}, ${contact})`);
  const fail = async (operation: Promise<unknown>, code: string) =>
    expect(
      operation.catch((error: unknown) => {
        throw error instanceof Error && error.cause ? error.cause : error;
      }),
    ).rejects.toMatchObject({ code });

  it('lets a user read and update only their own profile', async () => {
    await asUser(USER_C.uid, async (tx) => {
      expect(await rows(tx, sql`select id from artists`)).toEqual([{ id: ARTIST_C.id }]);
      await tx.update(artists).set({ name: 'Renamed', updatedAt: new Date() });
    });
    expect(await db().select({ id: artists.id, name: artists.name }).from(artists)).toEqual(
      expect.arrayContaining([
        { id: ARTIST_C.id, name: 'Renamed' },
        { id: ARTIST_A.id, name: ARTIST_A.name },
      ]),
    );
  });

  it("hides another user's profile and changes none of it", async () => {
    await asUser(USER_C.uid, async (tx) => {
      expect(await rows(tx, sql`select id from artists where id = 'flr'`)).toEqual([]);
      const updated = await tx
        .update(artists)
        .set({ name: 'Hijacked' })
        .where(eq(artists.id, 'flr'))
        .returning();
      expect(updated).toEqual([]);
    });
    expect(
      await db().select({ name: artists.name }).from(artists).where(eq(artists.id, 'flr')),
    ).toEqual([{ name: ARTIST_A.name }]);
  });

  it.each([
    ['id', sql`update artists set id = 'mine'`],
    ['a direct insert', sql`insert into artists (id, name) values ('mine', 'Mine')`],
    ['users.artist_id', sql`update users set artist_id = null`],
  ])('denies %s', async (_label, statement) => {
    await denied(asUser(USER_C.uid, (tx) => tx.execute(statement)));
  });

  it('creates and links one profile for a user without one, once', async () => {
    const [made] = await asUser(USER_B.uid, (tx) =>
      create(tx, 'New Band', 'https://new-band.bandcamp.com', 'Booking: new@example.com'),
    );
    expect(made).toMatchObject({
      name: 'New Band',
      bandcamp_url: 'https://new-band.bandcamp.com',
      contact_line: 'Booking: new@example.com',
    });
    expect(
      await db().select({ artistId: users.artistId }).from(users).where(eq(users.uid, USER_B.uid)),
    ).toEqual([{ artistId: made!.id }]);
    await fail(
      asUser(USER_B.uid, (tx) => create(tx, 'Second Band')),
      '23505',
    );
  });

  it('refuses a profile without a verified identity', async () => {
    await fail(
      asUser('', (tx) => create(tx, 'Nobody')),
      '42501',
    );
    await fail(
      asUser('ghost', (tx) => create(tx, 'Nobody')),
      '42501',
    );
  });

  it.each([
    ['a 101-character name', 'x'.repeat(101), null, null],
    ['a name with <', 'A <b>', null, null],
    ['a name with a comma', 'A, B', null, null],
    ['a name starting with #', '#band', null, null],
    ['a non-Bandcamp URL', 'Band', 'https://example.com', null],
    ['a contact line with #', 'Band', null, 'DM #me'],
  ])('rejects %s', async (_label, name, bandcamp, contact) => {
    await fail(
      asUser(USER_B.uid, (tx) => create(tx, name, bandcamp, contact)),
      '23514',
    );
    expect(
      await db().select({ artistId: users.artistId }).from(users).where(eq(users.uid, USER_B.uid)),
    ).toEqual([{ artistId: null }]);
  });

  it('never links two users to one profile', async () => {
    await fail(
      db().update(users).set({ artistId: 'flr' }).where(eq(users.uid, USER_B.uid)),
      '23505',
    );
  });

  it('rejects a top-level job with no artist', async () => {
    await denied(
      asUser(USER_A.uid, (tx) =>
        tx.insert(jobs).values(jobRow({ ...A_JOB, id: 'no-artist', artistId: null })),
      ),
    );
  });

  it('does not grant PUBLIC execution of the create function', async () => {
    expect(
      await rows(
        db(),
        sql`select acl.privilege_type from pg_proc p,
          lateral aclexplode(p.proacl) acl
          where p.oid = 'soundboard_create_artist(text,text,text)'::regprocedure
          and acl.grantee = 0`,
      ),
    ).toEqual([]);
  });
});

describe('identity bootstrap function', () => {
  it('binds only an unclaimed normalized invitation and preserves its artist link', async () => {
    await seed({
      artists: [{ id: 'artist-x', name: 'X Band' }],
      users: [{ email: 'new@example.test', artistId: 'artist-x' }],
    });
    const admitted = await restricted('app', 'new-sub', (tx) =>
      rows(tx, sql`select * from public.soundboard_admit('new-sub', ' New@Example.Test ', false)`),
    );
    expect(admitted).toMatchObject([
      { uid: 'new-sub', email: 'new@example.test', artist_id: 'artist-x', active: true },
    ]);
  });

  it('admits a bound account by subject without rebinding another invitation', async () => {
    await seed({ users: [{ email: 'new@example.test' }] });
    expect(
      await restricted('app', USER_A.uid, (tx) =>
        rows(
          tx,
          sql`select * from public.soundboard_admit(${USER_A.uid}, 'new@example.test', true)`,
        ),
      ),
    ).toMatchObject([{ uid: USER_A.uid, email: USER_A.email, artist_id: 'flr' }]);
    expect(
      await db().select().from(users).where(eq(users.email, 'new@example.test')),
    ).toMatchObject([{ uid: null }]);
  });

  it('denies a revoked subject even when another active invitation matches its email', async () => {
    await db().update(users).set({ active: false }).where(eq(users.uid, USER_A.uid));
    await seed({ users: [{ email: 'new@example.test' }] });
    expect(
      await restricted('app', USER_A.uid, (tx) =>
        rows(
          tx,
          sql`select * from public.soundboard_admit(${USER_A.uid}, 'new@example.test', true)`,
        ),
      ),
    ).toEqual([]);
    expect(
      await db().select().from(users).where(eq(users.email, 'new@example.test')),
    ).toMatchObject([{ uid: null }]);
  });

  it('creates an active unlinked account only in open mode', async () => {
    expect(
      await restricted('app', 'new-sub', (tx) =>
        rows(tx, sql`select * from public.soundboard_admit('new-sub', 'new@example.test', false)`),
      ),
    ).toEqual([]);
    expect(await db().select().from(users)).toHaveLength(USERS.users.length);

    expect(
      await restricted('app', 'new-sub', (tx) =>
        rows(tx, sql`select * from public.soundboard_admit('new-sub', 'new@example.test', true)`),
      ),
    ).toMatchObject([{ uid: 'new-sub', artist_id: null, active: true }]);
  });

  it.each([undefined, '', USER_B.uid])(
    'rejects an absent or forged subject context %s',
    async (uid) => {
      await denied(
        restricted('app', uid, (tx) =>
          tx.execute(
            sql`select * from public.soundboard_admit(${USER_A.uid}, ${USER_A.email}, true)`,
          ),
        ),
      );
    },
  );

  it.each([
    'soundboard_owns_job(text,text)',
    'soundboard_admit(text,text,boolean)',
    'soundboard_save_audience(text,timestamp with time zone,jsonb)',
  ])('does not grant PUBLIC or cleanup execution of %s', async (signature) => {
    expect(
      await rows(
        db(),
        sql`select acl.privilege_type from pg_proc p,
      lateral aclexplode(p.proacl) acl where p.oid = ${signature}::regprocedure
      and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        db(),
        sql`select has_function_privilege('soundboard_cleanup', ${signature}, 'EXECUTE') as allowed`,
      ),
    ).toEqual([{ allowed: false }]);
  });
});

describe('artist guides', () => {
  const asUser = <T>(uid: string, operation: (tx: Tx) => Promise<T>) =>
    restricted('app', uid, operation);
  const VOICE = JSON.stringify({ rules: ['Plain.'] });
  const NO_UPLOADS = JSON.stringify({
    uploads: [],
    drafts: [],
    edits: 2,
    approvals: 0,
    thin: true,
  });
  const UPLOADS = JSON.stringify({
    uploads: [{ videoId: 'v1', title: 'Song', publishedAt: '2026-10-01T00:00:00Z' }],
    drafts: [],
    edits: 0,
    approvals: 0,
    thin: true,
  });
  const claim = (tx: Tx, token: string, kind = 'voice') =>
    rows(tx, sql`select * from public.soundboard_claim_proposal(${kind}, ${token})`);
  const save = (tx: Tx, token: string, sources = NO_UPLOADS, kind = 'voice') =>
    rows(
      tx,
      sql`select * from public.soundboard_save_proposal(${kind}, ${VOICE}::jsonb, ${sources}::jsonb, ${token})`,
    );
  const fail = async (operation: Promise<unknown>, code: string) =>
    expect(
      operation.catch((error: unknown) => {
        throw error instanceof Error && error.cause ? error.cause : error;
      }),
    ).rejects.toMatchObject({ code });
  const guides = () =>
    db()
      .select({ artistId: artistGuides.artistId, status: artistGuides.status })
      .from(artistGuides)
      .orderBy(artistGuides.id);

  it("hides another artist's guides and changes none of them", async () => {
    await asUser(USER_C.uid, async (tx) => {
      expect(await rows(tx, sql`select id from artist_guides`)).toEqual([]);
      expect(await rows(tx, sql`update artist_guides set body = '{}' returning id`)).toEqual([]);
      expect(await rows(tx, sql`delete from artist_guides returning id`)).toEqual([]);
    });
    expect(await guides()).toEqual([{ artistId: 'flr', status: 'approved' }]);
  });

  it.each([
    [
      'a direct proposal insert',
      sql`insert into artist_guides (artist_id, kind, status, body, sources, proposed_at)
        values ('artist-c', 'voice', 'proposed', '{}', ${NO_UPLOADS}::jsonb, now())`,
    ],
    ['a status change', sql`update artist_guides set status = 'proposed'`],
    ['a grant_at write', sql`update artist_guides set grant_at = now()`],
    [
      'a claim insert',
      sql`insert into guide_claims (artist_id, kind) values ('artist-c', 'voice')`,
    ],
    ['a claimed_at write', sql`update guide_claims set claimed_at = now() - interval '1 minute'`],
    ['a claim grant_at write', sql`update guide_claims set grant_at = now()`],
  ])('denies %s', async (_label, statement) => {
    await denied(asUser(USER_C.uid, (tx) => tx.execute(statement)));
  });

  it('hides a proposal at 29 days and keeps an approved guide visible for good', async () => {
    await seed({
      artistGuides: [
        pendingProposal(
          ARTIST_C.id,
          'voice',
          { rules: ['day 29'] },
          {
            proposedAt: new Date(Date.now() - 29 * DAY_MS),
          },
        ),
        pendingProposal(
          ARTIST_C.id,
          'brand',
          { rules: ['day 28'] },
          {
            proposedAt: new Date(Date.now() - 29 * DAY_MS + 60_000),
          },
        ),
        { ...approvedGuide(ARTIST_C.id, 'voice', { rules: ['old'] }), proposedAt: new Date(0) },
      ],
    });
    expect(
      await asUser(USER_C.uid, (tx) =>
        rows(tx, sql`select kind, status from artist_guides order by id`),
      ),
    ).toEqual([
      { kind: 'brand', status: 'proposed' },
      { kind: 'voice', status: 'approved' },
    ]);
  });

  it.each([
    ['an approved row with a grant', { grantAt: new Date() }],
    ['an approved row without approved_at', { approvedAt: null }],
    ['sources missing a key', { sources: { uploads: 0, drafts: 0, edits: 0, approvals: 0 } }],
    ['proposal-shaped sources', { sources: JSON.parse(NO_UPLOADS) as object }],
  ])('refuses %s even to the owner', async (_label, patch) => {
    await fail(
      seed({ artistGuides: [{ ...approvedGuide(ARTIST_C.id, 'brand', { rules: [] }), ...patch }] }),
      '23514',
    );
  });

  it('claims, saves and replaces the caller artist proposal through the functions only', async () => {
    const saved = await asUser(USER_C.uid, async (tx) => {
      await claim(tx, 't1');
      await save(tx, 't1');
      await claim(tx, 't2');
      return save(tx, 't2', UPLOADS);
    });
    expect(saved).toMatchObject([{ artist_id: ARTIST_C.id, status: 'proposed', kind: 'voice' }]);
    expect(saved[0]!.grant_at).not.toBeNull();
    expect(await guides()).toEqual([
      { artistId: 'flr', status: 'approved' },
      { artistId: ARTIST_C.id, status: 'proposed' },
    ]);
    expect(await db().select().from(guideClaims)).toMatchObject([
      { artistId: ARTIST_C.id, claimToken: null, claimUntil: null },
    ]);
  });

  it('refuses a second claim while one runs and answers the held row', async () => {
    await asUser(USER_C.uid, async (tx) => {
      expect(await claim(tx, 't1')).toMatchObject([{ claim_token: 't1' }]);
      expect(await claim(tx, 't2')).toMatchObject([{ claim_token: 't1' }]);
      await fail(save(tx, 't2'), '55000');
    });
  });

  it.each([
    ['without a profile', USER_B.uid, (tx: Tx) => claim(tx, 't1')],
    ['without a profile, saving', USER_B.uid, (tx: Tx) => save(tx, 't1')],
    ['without a subject', '', (tx: Tx) => claim(tx, 't1')],
  ])('refuses the functions %s', async (_label, uid, operation) => {
    await fail(asUser(uid, operation), '42501');
  });

  it('refuses an empty claim token', async () => {
    await fail(
      asUser(USER_C.uid, (tx) => claim(tx, '')),
      '22023',
    );
  });

  it('refuses a save without its claim, or with another artist claim token', async () => {
    await fail(
      asUser(USER_C.uid, (tx) => save(tx, 'never-claimed')),
      '55000',
    );
    await asUser(USER_A.uid, (tx) => claim(tx, 'a-token'));
    await fail(
      asUser(USER_C.uid, (tx) => save(tx, 'a-token')),
      '55000',
    );
    expect(await guides()).toEqual([{ artistId: 'flr', status: 'approved' }]);
  });

  it.each([
    ['in the future', sql`now() + interval '1 hour'`],
    ['over 3 minutes old', sql`now() - interval '4 minutes'`],
  ])('refuses a claim time %s, whatever claim_until says', async (_label, claimedAt) => {
    await asUser(USER_C.uid, (tx) => claim(tx, 't1'));
    await db().execute(
      sql`update guide_claims set claimed_at = ${claimedAt}, claim_until = now() + interval '1 day'`,
    );
    await fail(
      asUser(USER_C.uid, (tx) => save(tx, 't1')),
      '55000',
    );
    expect(await guides()).toEqual([{ artistId: 'flr', status: 'approved' }]);
  });

  it('refuses uploads read through a grant that was replaced before the save', async () => {
    await asUser(USER_C.uid, (tx) => claim(tx, 't1'));
    await db()
      .update(connections)
      .set({ updatedAt: new Date(Date.now() + 1000) })
      .where(eq(connections.uid, USER_C.uid));
    await fail(
      asUser(USER_C.uid, (tx) => save(tx, 't1', UPLOADS)),
      '28000',
    );
    // Edits alone hold no YouTube data, so they save without a grant.
    expect(await asUser(USER_C.uid, (tx) => save(tx, 't1'))).toMatchObject([{ grant_at: null }]);
  });

  it('ignores temp tables that shadow the ones the functions write', async () => {
    const saved = await asUser(USER_C.uid, async (tx) => {
      for (const table of ['users', 'connections', 'guide_claims', 'artist_guides']) {
        await tx.execute(
          sql.raw(
            `create temp table ${table} (like public.${table} including defaults) on commit drop`,
          ),
        );
      }
      await tx.execute(sql`insert into pg_temp.users (uid, email, artist_id, active)
        values (${USER_C.uid}, 'c@example.com', 'flr', true)`);
      await claim(tx, 't1');
      const row = await save(tx, 't1', UPLOADS);
      expect(await rows(tx, sql`select count(*)::int as n from pg_temp.guide_claims`)).toEqual([
        { n: 0 },
      ]);
      expect(await rows(tx, sql`select count(*)::int as n from pg_temp.artist_guides`)).toEqual([
        { n: 0 },
      ]);
      return row;
    });
    expect(saved).toMatchObject([{ artist_id: ARTIST_C.id }]);
  });

  it('pins each function search path, temp schema last, and grants PUBLIC nothing', async () => {
    expect(
      await rows(
        db(),
        sql`select p.proname, p.prosecdef, p.proconfig from pg_proc p
          where p.proname in ('soundboard_claim_proposal', 'soundboard_save_proposal')
          order by p.proname`,
      ),
    ).toEqual(
      ['soundboard_claim_proposal', 'soundboard_save_proposal'].map((proname) => ({
        proname,
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, public, pg_temp'],
      })),
    );
    expect(
      await rows(
        db(),
        sql`select p.proname from pg_proc p, lateral aclexplode(p.proacl) acl
          where p.proname in ('soundboard_claim_proposal', 'soundboard_save_proposal')
          and acl.grantee = 0`,
      ),
    ).toEqual([]);
  });

  it('lets cleanup see and delete only expired proposals, never their bodies', async () => {
    await seed({
      artistGuides: [
        pendingProposal(
          ARTIST_C.id,
          'voice',
          { rules: ['old'] },
          {
            proposedAt: new Date(Date.now() - 30 * DAY_MS),
          },
        ),
        pendingProposal(ARTIST_C.id, 'brand', { rules: ['new'] }),
      ],
    });
    await restricted('cleanup', undefined, async (tx) => {
      expect(await rows(tx, sql`select status from artist_guides`)).toEqual([
        { status: 'proposed' },
      ]);
      expect(await rows(tx, sql`delete from artist_guides returning status`)).toEqual([
        { status: 'proposed' },
      ]);
    });
    await denied(
      restricted('cleanup', undefined, (tx) => tx.execute(sql`select body from artist_guides`)),
    );
    await denied(
      restricted('cleanup', undefined, (tx) => tx.execute(sql`select * from guide_claims`)),
    );
    expect(await guides()).toEqual([
      { artistId: 'flr', status: 'approved' },
      { artistId: ARTIST_C.id, status: 'proposed' },
    ]);
  });
});

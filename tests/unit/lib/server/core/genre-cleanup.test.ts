// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_CLEANUP_ROLE,
  DELETE_EXPIRED_GENRE_EVIDENCE,
  DELETE_EXPIRED_OUTCOMES,
  DELETE_EXPIRED_PROPOSALS,
  DELETE_EXPIRED_REJECTIONS,
  DELETE_EXPIRED_RESEARCH,
  handleGenreCleanup,
  type CleanupConnection,
} from '#lib/server/core/genre-cleanup.js';
import { client, seed, truncate } from '../../../../helpers/db';

const triggerRequest = (scheduledAt = '2099-01-01T00:00:00Z') =>
  new Request('https://cleanup.test/', {
    method: 'POST',
    headers: { 'X-Neon-Trigger-Invocation-Id': 'neon-invocation' },
    body: JSON.stringify({ data: { scheduled_at: scheduledAt } }),
  });

const driver = () => ({
  connect: vi.fn(async () => undefined),
  query: vi.fn<(statement: string) => Promise<{ rows: unknown[] }>>(async (statement) => ({
    rows: statement === CHECK_CLEANUP_ROLE ? [{ allowed: true }] : [],
  })),
  end: vi.fn(async () => undefined),
});

const PROPOSED_SOURCES = `'{"uploads":[],"drafts":[],"edits":0,"approvals":0,"thin":false}'`;
const APPROVED_SOURCES = `'{"uploads":0,"drafts":0,"edits":0,"approvals":0,"carriedOver":false}'`;

const databaseDriver = () => ({
  connect: vi.fn(async () => undefined),
  query: vi.fn((statement: string) => client().query(statement)),
  end: vi.fn(async () => undefined),
});

const DELETES = [
  DELETE_EXPIRED_GENRE_EVIDENCE,
  DELETE_EXPIRED_PROPOSALS,
  DELETE_EXPIRED_RESEARCH,
  DELETE_EXPIRED_OUTCOMES,
  DELETE_EXPIRED_REJECTIONS,
];
/** Which delete (1-based) fails. */
const FAILING = {
  delete: 1,
  'proposal delete': 2,
  'research delete': 3,
  'outcome delete': 4,
  'rejection delete': 5,
} as const;
const NONE = { deleted: 0, proposals: 0, research: 0, outcomes: 0, rejections: 0 };

beforeEach(truncate);

describe('handleGenreCleanup', () => {
  it('rejects other HTTP methods before opening a database connection', async () => {
    const factory = vi.fn();

    const response = await handleGenreCleanup(new Request('https://cleanup.test/'), factory);

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('rejects a missing or empty trigger header (%s)', async (header) => {
    const factory = vi.fn();
    const headers = new Headers();
    if (header !== undefined) headers.set('X-Neon-Trigger-Invocation-Id', header);

    const response = await handleGenreCleanup(
      new Request('https://cleanup.test/', { method: 'POST', headers }),
      factory,
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Forbidden');
    expect(factory).not.toHaveBeenCalled();
  });

  it('deletes expired evidence and proposals at the database cutoffs and ignores the supplied schedule time', async () => {
    await seed({
      artists: [{ id: 'artist-1', name: 'Artist' }],
      users: [{ email: 'artist@example.test', uid: 'artist' }],
      jobs: ['expired', 'boundary', 'fresh'].map((id) => ({
        id,
        ownerUid: 'artist',
        state: 'REVIEW' as const,
        createdAt: new Date(),
        data: {},
      })),
    });
    const database = client();
    const connection = databaseDriver() satisfies CleanupConnection;
    const factory = vi.fn(() => connection);
    // A transaction fixes Postgres now() so the exact 30-day boundary is repeatable.
    await database.exec('begin');
    try {
      await database.exec(`
        insert into job_audience (job_id, retrieved_at, evidence) values
          ('expired', now() - interval '31 days', '{}'),
          ('boundary', now() - interval '30 days', '{}'),
          ('fresh', now() - interval '29 days', '{}');
        insert into artist_guides (artist_id, kind, status, body, sources, proposed_at, approved_at) values
          ('artist-1', 'voice', 'proposed', '{"rules":["a"]}', ${PROPOSED_SOURCES}, now() - interval '29 days', null),
          ('artist-1', 'brand', 'proposed', '{"rules":["b"]}', ${PROPOSED_SOURCES}, now() - interval '28 days 23 hours', null),
          ('artist-1', 'voice', 'approved', '{"rules":["c"]}', ${APPROVED_SOURCES}, now() - interval '400 days', now() - interval '400 days');
        insert into job_research (run_id, job_id, retrieved_at, evidence) values
          ('r-expired', 'expired', now() - interval '29 days', '{}'),
          ('r-fresh', 'fresh', now() - interval '28 days 23 hours', '{}');
        insert into artist_outcomes (artist_id, video_id, retrieved_at, published_at, requested_start,
            requested_end, coverage, metrics, live) values
          ('artist-1', 'v-expired', now() - interval '30 days', now(), '2026-01-01', '2026-01-28', 'complete', '{}', '{}'),
          ('artist-1', 'v-boundary', now() - interval '29 days', now(), '2026-01-01', '2026-01-28', 'complete', '{}', '{}'),
          ('artist-1', 'v-fresh', now() - interval '28 days', now(), '2026-01-01', '2026-01-28', 'open', '{}', '{}');
        insert into peer_rejections (artist_id, channel_id, retrieved_at) values
          ('artist-1', 'UC-expired', now() - interval '29 days'),
          ('artist-1', 'UC-fresh', now() - interval '1 day');
      `);
      await database.exec('set local session authorization soundboard_cleanup');

      const response = await handleGenreCleanup(triggerRequest(), factory);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        deleted: 2,
        proposals: 1,
        research: 1,
        outcomes: 2,
        rejections: 1,
      });
      expect(factory).toHaveBeenCalledOnce();
      expect(connection.connect).toHaveBeenCalledOnce();
      expect(connection.query.mock.calls).toEqual([
        [CHECK_CLEANUP_ROLE],
        ...DELETES.map((d) => [d]),
      ]);
      expect(connection.end).toHaveBeenCalledOnce();
      // PGlite's RESET SESSION AUTHORIZATION keeps the current identity.
      await database.exec('set session authorization postgres');
      expect((await database.query('select job_id from job_audience')).rows).toEqual([
        { job_id: 'fresh' },
      ]);
      expect((await database.query('select id from jobs order by id')).rows).toEqual([
        { id: 'boundary' },
        { id: 'expired' },
        { id: 'fresh' },
      ]);
      // An approved guide never expires; the 28-day proposal is still inside its window.
      expect(
        (await database.query('select kind, status from artist_guides order by id')).rows,
      ).toEqual([
        { kind: 'brand', status: 'proposed' },
        { kind: 'voice', status: 'approved' },
      ]);
      expect((await database.query('select run_id from job_research')).rows).toEqual([
        { run_id: 'r-fresh' },
      ]);
      expect((await database.query('select video_id from artist_outcomes')).rows).toEqual([
        { video_id: 'v-fresh' },
      ]);
      expect((await database.query('select channel_id from peer_rejections')).rows).toEqual([
        { channel_id: 'UC-fresh' },
      ]);

      await database.exec('set local session authorization soundboard_cleanup');
      const repeated = await handleGenreCleanup(triggerRequest('1900-01-01T00:00:00Z'), factory);
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual(NONE);
      expect(connection.end).toHaveBeenCalledTimes(2);
    } finally {
      await database.exec('rollback');
      await database.exec('set session authorization postgres');
    }
  });

  it.each([
    { label: 'missing row', rows: [] },
    { label: 'missing allowed field', rows: [{}] },
    { label: 'null row', rows: [null] },
    { label: 'unsafe role', rows: [{ allowed: false }] },
    { label: 'string allowed value', rows: [{ allowed: 'true' }] },
    { label: 'numeric allowed value', rows: [{ allowed: 1 }] },
  ])('closes without deleting when role validation returns $label', async ({ rows }) => {
    const connection = driver();
    connection.query.mockResolvedValueOnce({ rows });

    const response = await handleGenreCleanup(triggerRequest(), () => connection);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Genre evidence cleanup failed');
    expect(connection.connect).toHaveBeenCalledOnce();
    expect(connection.query).toHaveBeenCalledExactlyOnceWith(CHECK_CLEANUP_ROLE);
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'owner login', statements: [] },
    { label: 'owner login using SET ROLE', statements: ['set local role soundboard_cleanup'] },
    {
      label: 'another restricted login',
      statements: ['set local session authorization soundboard_app'],
    },
    ...['superuser', 'bypassrls', 'createrole', 'createdb', 'replication'].map((privilege) => ({
      label: privilege,
      statements: [
        `alter role soundboard_cleanup ${privilege}`,
        'set local session authorization soundboard_cleanup',
      ],
    })),
    {
      label: 'role membership',
      statements: [
        'grant soundboard_app to soundboard_cleanup',
        'set local session authorization soundboard_cleanup',
      ],
    },
    {
      label: 'object ownership',
      statements: [
        'create table public.cleanup_guard_owned (id integer)',
        'alter table public.cleanup_guard_owned owner to soundboard_cleanup',
        'set local session authorization soundboard_cleanup',
      ],
    },
  ])(
    'rejects an actual database connection with $label before deletion',
    async ({ statements }) => {
      const database = client();
      const connection = databaseDriver();
      await database.exec('begin');
      try {
        for (const statement of statements) await database.exec(statement);

        const response = await handleGenreCleanup(triggerRequest(), () => connection);

        expect(response.status).toBe(500);
        expect(await response.text()).toBe('Genre evidence cleanup failed');
        expect(connection.connect).toHaveBeenCalledOnce();
        expect(connection.query).toHaveBeenCalledExactlyOnceWith(CHECK_CLEANUP_ROLE);
        expect(connection.end).toHaveBeenCalledOnce();
      } finally {
        await database.exec('rollback');
        await database.exec('set session authorization postgres');
      }
    },
  );

  it.each([
    'connect',
    'role check',
    'delete',
    'proposal delete',
    'research delete',
    'outcome delete',
    'rejection delete',
  ] as const)(
    'closes the connection and hides database errors when %s fails',
    async (operation) => {
      const connection = driver();
      const error = new Error('private connection details');
      if (operation === 'connect') connection.connect.mockRejectedValueOnce(error);
      else if (operation === 'role check') connection.query.mockRejectedValueOnce(error);
      else {
        const failing = FAILING[operation];
        connection.query.mockResolvedValueOnce({ rows: [{ allowed: true }] });
        for (let i = 1; i < failing; i++) connection.query.mockResolvedValueOnce({ rows: [] });
        connection.query.mockRejectedValueOnce(error);
      }

      const response = await handleGenreCleanup(triggerRequest(), () => connection);

      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Genre evidence cleanup failed');
      expect(connection.connect).toHaveBeenCalledOnce();
      expect(connection.end).toHaveBeenCalledOnce();
      if (operation === 'connect') expect(connection.query).not.toHaveBeenCalled();
      else if (operation === 'role check')
        expect(connection.query).toHaveBeenCalledExactlyOnceWith(CHECK_CLEANUP_ROLE);
      else
        expect(connection.query.mock.calls).toEqual(
          [[CHECK_CLEANUP_ROLE], ...DELETES.map((d) => [d])].slice(0, FAILING[operation] + 1),
        );
    },
  );

  it('returns a sanitized failure when closing the database connection fails', async () => {
    const connection = driver();
    connection.end.mockRejectedValueOnce(new Error('private close details'));

    const response = await handleGenreCleanup(triggerRequest(), () => connection);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Genre evidence cleanup connection failed');
    expect(connection.query.mock.calls).toEqual([[CHECK_CLEANUP_ROLE], ...DELETES.map((d) => [d])]);
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it('returns a sanitized failure when creating the connection throws', async () => {
    const factory = vi.fn(() => {
      throw new Error('private factory details');
    });

    const response = await handleGenreCleanup(triggerRequest(), factory);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Genre evidence cleanup failed');
    expect(factory).toHaveBeenCalledOnce();
  });
});

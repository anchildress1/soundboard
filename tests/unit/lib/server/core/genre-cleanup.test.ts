// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELETE_EXPIRED_GENRE_EVIDENCE,
  handleGenreCleanup,
  type CleanupConnection,
} from '$lib/server/core/genre-cleanup';
import { client, seed, truncate } from '../../../../helpers/db';

const triggerRequest = (scheduledAt = '2099-01-01T00:00:00Z') =>
  new Request('https://cleanup.test/', {
    method: 'POST',
    headers: { 'X-Neon-Trigger-Invocation-Id': 'neon-invocation' },
    body: JSON.stringify({ data: { scheduled_at: scheduledAt } }),
  });

const driver = () => ({
  connect: vi.fn(async () => undefined),
  query: vi.fn<(statement: string) => Promise<{ rows: unknown[] }>>(async () => ({ rows: [] })),
  end: vi.fn(async () => undefined),
});

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

  it('deletes expired evidence at the database cutoff and ignores the supplied schedule time', async () => {
    await seed({
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
    const connection = {
      connect: vi.fn(async () => undefined),
      query: vi.fn((statement: string) => database.query(statement)),
      end: vi.fn(async () => undefined),
    } satisfies CleanupConnection;
    const factory = vi.fn(() => connection);
    // A transaction fixes Postgres now() so the exact 30-day boundary is repeatable.
    await database.exec('begin');
    try {
      await database.exec(`
        insert into job_audience (job_id, retrieved_at, evidence) values
          ('expired', now() - interval '31 days', '{}'),
          ('boundary', now() - interval '30 days', '{}'),
          ('fresh', now() - interval '29 days', '{}')
      `);

      const response = await handleGenreCleanup(triggerRequest(), factory);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deleted: 2 });
      expect(factory).toHaveBeenCalledOnce();
      expect(connection.connect).toHaveBeenCalledOnce();
      expect(connection.query).toHaveBeenCalledExactlyOnceWith(DELETE_EXPIRED_GENRE_EVIDENCE);
      expect(connection.end).toHaveBeenCalledOnce();
      expect((await database.query('select job_id from job_audience')).rows).toEqual([
        { job_id: 'fresh' },
      ]);
      expect((await database.query('select id from jobs order by id')).rows).toEqual([
        { id: 'boundary' },
        { id: 'expired' },
        { id: 'fresh' },
      ]);

      const repeated = await handleGenreCleanup(triggerRequest('1900-01-01T00:00:00Z'), factory);
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual({ deleted: 0 });
      expect(connection.end).toHaveBeenCalledTimes(2);
    } finally {
      await database.exec('rollback');
    }
  });

  it.each(['connect', 'query'] as const)(
    'closes the connection and hides database errors when %s fails',
    async (operation) => {
      const connection = driver();
      connection[operation].mockRejectedValueOnce(new Error('private connection details'));

      const response = await handleGenreCleanup(triggerRequest(), () => connection);

      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Genre evidence cleanup failed');
      expect(connection.connect).toHaveBeenCalledOnce();
      expect(connection.end).toHaveBeenCalledOnce();
      if (operation === 'connect') expect(connection.query).not.toHaveBeenCalled();
      else expect(connection.query).toHaveBeenCalledExactlyOnceWith(DELETE_EXPIRED_GENRE_EVIDENCE);
    },
  );

  it('returns a sanitized failure when closing the database connection fails', async () => {
    const connection = driver();
    connection.end.mockRejectedValueOnce(new Error('private close details'));

    const response = await handleGenreCleanup(triggerRequest(), () => connection);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Genre evidence cleanup connection failed');
    expect(connection.query).toHaveBeenCalledExactlyOnceWith(DELETE_EXPIRED_GENRE_EVIDENCE);
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

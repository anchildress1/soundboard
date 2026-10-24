// @vitest-environment node
import { captureException } from '@sentry/sveltekit';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The `.js` suffix slips past vitest.config.ts's exact-match alias to the PGlite helper, so this
// file tests the real module with `pg` mocked at the process boundary.
import { db, query, resetDb } from '$lib/server/core/db.js';
import { withIdentity } from '$lib/server/core/identity';

const pg = vi.hoisted(() => ({
  failedSql: undefined as string | undefined,
  role: undefined as Record<string, unknown> | undefined,
  clients: [] as {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }[],
  pools: [] as {
    options: unknown;
    query: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    handlers: Map<string, (error: Error) => void>;
  }[],
}));

vi.mock('pg', () => ({
  Pool: class {
    query = vi.fn(async () => ({ rows: [{ one: 1 }], rowCount: 1, fields: [] }));
    connect = vi.fn(async () => {
      const client = {
        query: vi.fn(async (statement: { text: string }) => {
          if (pg.failedSql && statement.text.includes(pg.failedSql))
            throw new Error('database refused');
          return {
            rows: statement.text.includes('pg_catalog.pg_roles')
              ? pg.role
                ? [pg.role]
                : []
              : [{ one: 1 }],
            rowCount: 1,
            fields: [],
          };
        }),
        release: vi.fn(),
      };
      pg.clients.push(client);
      return client;
    });
    end = vi.fn(async () => undefined);
    handlers = new Map<string, (error: Error) => void>();
    constructor(readonly options: unknown) {
      pg.pools.push(this as never);
    }
    on(event: string, handler: (error: Error) => void) {
      this.handlers.set(event, handler);
      return this;
    }
  },
}));

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://app@pooler.test/soundboard');
  resetDb();
  pg.pools.length = 0;
  pg.clients.length = 0;
  pg.failedSql = undefined;
  pg.role = {
    name: 'soundboard_app',
    login: 'soundboard_app',
    superuser: false,
    bypassRls: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    memberships: false,
    ownsObjects: false,
  };
  vi.clearAllMocks();
});

const statements = (client: (typeof pg.clients)[number]) =>
  client.query.mock.calls.map(([statement]) => (statement as { text: string }).text);

describe('query', () => {
  it.each([undefined, ''])('rejects a missing identity (%s) before opening a pool', async (uid) => {
    const operation = vi.fn(async () => 1);

    await expect(withIdentity(uid, () => query(operation))).rejects.toThrow(
      'Database operation requires a verified Google account.',
    );

    expect(operation).not.toHaveBeenCalled();
    expect(pg.pools).toHaveLength(0);
  });

  it('sets a parameterized transaction-local identity before work and releases after commit', async () => {
    const uid = "google-sub'; rollback; --";
    const result = await withIdentity(uid, () =>
      query(async (tx) => {
        const result = (await tx.execute(sql`select 1 as one`)) as { rows: unknown[] };
        return result.rows;
      }),
    );

    expect(result).toEqual([{ one: 1 }]);
    expect(pg.pools[0]!.query).not.toHaveBeenCalled();
    const client = pg.clients[0]!;
    expect(statements(client)).toEqual([
      'begin',
      expect.stringContaining('pg_catalog.pg_roles'),
      "select set_config('app.user_sub', $1, true)",
      'select 1 as one',
      'commit',
    ]);
    expect(client.query.mock.calls[2]![1]).toEqual([uid]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'owner' },
    { login: 'owner' },
    { superuser: true },
    { bypassRls: true },
    { createRole: true },
    { createDatabase: true },
    { replication: true },
    { memberships: true },
    { ownsObjects: true },
    { bypassRls: undefined },
  ])('rejects an unsafe runtime role %j before setting identity or running work', async (patch) => {
    pg.role = { ...pg.role, ...patch };
    const operation = vi.fn(async () => 1);

    await expect(withIdentity('alice', () => query(operation))).rejects.toThrow(
      'Database runtime must use the unprivileged soundboard_app login.',
    );

    expect(operation).not.toHaveBeenCalled();
    const client = pg.clients[0]!;
    expect(statements(client)).toEqual([
      'begin',
      expect.stringContaining('pg_catalog.pg_roles'),
      'rollback',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects a missing runtime role row and releases after rollback', async () => {
    pg.role = undefined;
    const operation = vi.fn(async () => 1);

    await expect(withIdentity('alice', () => query(operation))).rejects.toThrow(
      'Database runtime must use the unprivileged soundboard_app login.',
    );

    expect(operation).not.toHaveBeenCalled();
    expect(statements(pg.clients[0]!)).toContain('rollback');
    expect(pg.clients[0]!.release).toHaveBeenCalledOnce();
  });

  it('rolls back failed work and preserves the original error', async () => {
    const error = new Error('write failed');

    await expect(
      withIdentity('alice', () =>
        query(async (tx) => {
          await tx.execute(sql`select 1 as one`);
          throw error;
        }),
      ),
    ).rejects.toBe(error);

    expect(statements(pg.clients[0]!).slice(-2)).toEqual(['select 1 as one', 'rollback']);
    expect(statements(pg.clients[0]!)).not.toContain('commit');
    expect(pg.clients[0]!.release).toHaveBeenCalledOnce();
  });

  it.each(['pg_catalog.pg_roles', 'set_config'])('rolls back when %s fails', async (failedSql) => {
    pg.failedSql = failedSql;
    const operation = vi.fn(async () => 1);

    await expect(withIdentity('alice', () => query(operation))).rejects.toThrow('Failed query');

    expect(operation).not.toHaveBeenCalled();
    expect(statements(pg.clients[0]!)).toContain('rollback');
    expect(pg.clients[0]!.release).toHaveBeenCalledOnce();
  });

  it('propagates connection failures without running work', async () => {
    db();
    const error = new Error('connection unavailable');
    pg.pools[0]!.connect.mockRejectedValueOnce(error);
    const operation = vi.fn(async () => 1);

    await expect(withIdentity('alice', () => query(operation))).rejects.toBe(error);

    expect(operation).not.toHaveBeenCalled();
    expect(pg.clients).toHaveLength(0);
  });

  it('isolates concurrent identities on separate transaction clients', async () => {
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    let started!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const alice = withIdentity('alice', () =>
      query(async (tx) => {
        started();
        await paused;
        await tx.execute(sql`select 1 as one`);
        return 'alice';
      }),
    );
    await entered;

    const bob = await withIdentity('bob', () => query(async () => 'bob'));
    resume();

    expect(await alice).toBe('alice');
    expect(bob).toBe('bob');
    expect(pg.clients.map((client) => client.query.mock.calls[2]![1])).toEqual([
      ['alice'],
      ['bob'],
    ]);
    for (const client of pg.clients) expect(client.release).toHaveBeenCalledOnce();
  });

  it('rechecks privileges on every operation on a reused pool', async () => {
    expect(await withIdentity('alice', () => query(async () => 1))).toBe(1);
    pg.role = { ...pg.role, bypassRls: true };

    await expect(withIdentity('alice', () => query(async () => 2))).rejects.toThrow(
      'Database runtime must use the unprivileged soundboard_app login.',
    );

    expect(pg.pools).toHaveLength(1);
    expect(pg.clients).toHaveLength(2);
    expect(statements(pg.clients[1]!)).toContain('rollback');
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('db', () => {
  it('builds one pool from DATABASE_URL and reuses it', () => {
    expect(db()).toBe(db());
    expect(pg.pools).toHaveLength(1);
    expect(pg.pools[0]!.options).toEqual({
      connectionString: 'postgres://app@pooler.test/soundboard',
      connectionTimeoutMillis: 10_000,
    });
  });

  it('sends queries through the pool', async () => {
    const result = (await db().execute(sql`select 1 as one`)) as { rows: unknown[] };
    expect(pg.pools[0]!.query).toHaveBeenCalledOnce();
    expect(result.rows).toEqual([{ one: 1 }]);
  });

  it('throws without DATABASE_URL and creates no pool', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => db()).toThrow('Missing required env var DATABASE_URL');
    expect(pg.pools).toHaveLength(0);
  });

  it('reports idle-connection errors instead of crashing', () => {
    db();
    const error = new Error('terminating connection due to administrator command');
    pg.pools[0]!.handlers.get('error')!(error);
    expect(captureException).toHaveBeenCalledWith(error, { tags: { component: 'db' } });
  });
});

describe('resetDb', () => {
  it('ends the pool and reconnects with current env on next use', () => {
    db();
    resetDb();
    expect(pg.pools[0]!.end).toHaveBeenCalledOnce();
    vi.stubEnv('DATABASE_URL', 'postgres://app@other.test/soundboard');
    db();
    expect(pg.pools).toHaveLength(2);
    expect(pg.pools[1]!.options).toEqual({
      connectionString: 'postgres://app@other.test/soundboard',
      connectionTimeoutMillis: 10_000,
    });
  });

  it('reports a pool that fails to end', async () => {
    db();
    const error = new Error('end failed');
    pg.pools[0]!.end.mockRejectedValueOnce(error);
    resetDb();
    await vi.waitFor(() =>
      expect(captureException).toHaveBeenCalledWith(error, { tags: { component: 'db' } }),
    );
  });

  it('is a no-op before first use', () => {
    expect(() => resetDb()).not.toThrow();
    expect(pg.pools).toHaveLength(0);
  });
});

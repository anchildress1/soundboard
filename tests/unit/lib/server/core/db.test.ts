// @vitest-environment node
import { captureException } from '@sentry/sveltekit';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The `.js` suffix slips past vitest.config.ts's exact-match alias to the PGlite helper, so this
// file tests the real module with `pg` mocked at the process boundary.
import { db, resetDb } from '$lib/server/core/db.js';

const pg = vi.hoisted(() => ({
  pools: [] as {
    options: unknown;
    query: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    handlers: Map<string, (error: Error) => void>;
  }[],
}));

vi.mock('pg', () => ({
  Pool: class {
    query = vi.fn(async () => ({ rows: [{ one: 1 }], rowCount: 1, fields: [] }));
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
  vi.clearAllMocks();
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
    });
  });

  it('is a no-op before first use', () => {
    expect(() => resetDb()).not.toThrow();
    expect(pg.pools).toHaveLength(0);
  });
});

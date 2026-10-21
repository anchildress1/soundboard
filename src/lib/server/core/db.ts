import { captureException } from '@sentry/sveltekit';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { required } from './env';
import * as schema from './schema';

/** Driver-neutral, so the PGlite databases tests and E2E builds swap in satisfy the same type. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

let pool: Pool | null = null;
let database: Database | null = null;

/** Drizzle over one `pg` Pool on `DATABASE_URL`, created on first use. */
export function db(): Database {
  if (!database) {
    // Bounded, so a cold or unreachable Neon fails the request instead of hanging it.
    pool = new Pool({
      connectionString: required('DATABASE_URL'),
      connectionTimeoutMillis: 10_000,
    });
    // Neon closes idle connections when it scales to zero; unhandled, that error kills the process.
    // The pool already discards the dead client, so report it and carry on.
    pool.on('error', (error) => captureException(error, { tags: { component: 'db' } }));
    database = drizzle(pool, { schema });
  }
  return database;
}

/** Drops the pool so the next `db()` reconnects with current env vars. */
export function resetDb(): void {
  pool?.end().catch((error: unknown) => captureException(error, { tags: { component: 'db' } }));
  pool = null;
  database = null;
}

/** A transaction handle, for helpers that write inside the caller's transaction. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

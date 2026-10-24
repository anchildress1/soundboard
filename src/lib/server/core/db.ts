import { captureException } from '@sentry/sveltekit';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { required } from './env';
import { currentIdentity } from './identity';
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

type RuntimeRole = {
  name: string;
  login: string;
  superuser: boolean;
  bypassRls: boolean;
  createRole: boolean;
  createDatabase: boolean;
  replication: boolean;
  memberships: boolean;
  ownsObjects: boolean;
};

/** Runs database work in a short transaction bound to the verified Google account. */
export async function query<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
  const uid = currentIdentity();
  if (!uid) throw new Error('Database operation requires a verified Google account.');
  return await db().transaction(async (tx) => {
    // Check the actual connection, so an owner URL or later privilege drift cannot bypass RLS.
    const result = (await tx.execute(sql`
      select r.rolname as name, session_user as login,
        r.rolsuper as superuser, r.rolbypassrls as "bypassRls",
        r.rolcreaterole as "createRole", r.rolcreatedb as "createDatabase",
        r.rolreplication as replication,
        exists (select 1 from pg_catalog.pg_auth_members m where m.member = r.oid)
          as memberships,
        exists (select 1 from pg_catalog.pg_shdepend d
          where d.refclassid = 'pg_catalog.pg_authid'::regclass
            and d.refobjid = r.oid and d.deptype = 'o') as "ownsObjects"
      from pg_catalog.pg_roles r where r.rolname = current_user
    `)) as { rows: RuntimeRole[] };
    const role = result.rows[0];
    if (
      role?.name !== 'soundboard_app' ||
      role.login !== 'soundboard_app' ||
      role.superuser !== false ||
      role.bypassRls !== false ||
      role.createRole !== false ||
      role.createDatabase !== false ||
      role.replication !== false ||
      role.memberships !== false ||
      role.ownsObjects !== false
    ) {
      throw new Error('Database runtime must use the unprivileged soundboard_app login.');
    }
    await tx.execute(sql`select set_config('app.user_sub', ${uid}, true)`);
    return operation(tx);
  });
}

/** Drops the pool so the next `db()` reconnects with current env vars. */
export function resetDb(): void {
  pool?.end().catch((error: unknown) => captureException(error, { tags: { component: 'db' } }));
  pool = null;
  database = null;
}

/** A transaction handle, for helpers that write inside the caller's transaction. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

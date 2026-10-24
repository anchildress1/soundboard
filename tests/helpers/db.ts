// Stands in for $lib/server/core/db: unit tests (vitest.config.ts alias) and the E2E build
// (tests/e2e/fakes/db.ts) run real SQL on an in-process PGlite with the real migrations, so the
// database is never mocked. Each test file gets its own instance through module isolation.
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { resolve } from 'node:path';
import type { Database, Tx } from '$lib/server/core/db';
import { currentIdentity } from '$lib/server/core/identity';
import * as schema from '$lib/server/core/schema';

// Resolved from the working directory, not this file: vitest and the Playwright web server both
// run from the repo root, and the E2E build bundles this module away from its source path.
const pglite = new PGlite();
const database = drizzle(pglite, { schema });
await migrate(database, { migrationsFolder: resolve('drizzle') });

export function db(): Database {
  return database;
}

/** Seeds/assertions stay privileged; request-scoped operations exercise the runtime policies. */
export function query<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
  const uid = currentIdentity();
  return database.transaction(async (tx) => {
    if (uid) {
      await tx.execute(sql`set local role soundboard_app`);
      await tx.execute(sql`select set_config('app.user_sub', ${uid}, true)`);
    }
    return operation(tx);
  });
}

/** The raw PGlite under `db()`, for code that speaks pg's `query(text, params)`. */
export function client(): PGlite {
  return pglite;
}

/** The instance lives for the whole test file; there is no pool to drop. */
export function resetDb(): void {}

/** Empties every table and drops any `afterJobUpdate` hook; tests call this first. */
export async function truncate(): Promise<void> {
  await database.execute(sql`drop trigger if exists after_job_update on jobs`);
  await database.execute(
    sql`truncate users, connections, jobs, job_audience, artist_memory restart identity cascade`,
  );
}

/**
 * Runs `statement` (PL/pgSQL, with the updated row as `new`) after every job UPDATE: a concurrent
 * writer landing mid-request, such as the bucket lifecycle deleting a job.
 */
export async function afterJobUpdate(statement: string): Promise<void> {
  await database.execute(
    sql.raw(
      `create or replace function after_job_update() returns trigger language plpgsql as $$ begin ${statement}; return null; end $$`,
    ),
  );
  await database.execute(
    sql`create trigger after_job_update after update on jobs for each row execute function after_job_update()`,
  );
}

/** Deletes each job right after it is updated. */
export const vanishOnUpdate = () => afterJobUpdate('delete from jobs where id = new.id');

type Insert<T extends keyof typeof schema> = (typeof schema)[T] extends {
  $inferInsert: infer Row;
}
  ? Row
  : never;

export type Seed = Partial<{
  users: Insert<'users'>[];
  connections: Insert<'connections'>[];
  jobs: Insert<'jobs'>[];
  jobAudience: Insert<'jobAudience'>[];
  artistMemory: Insert<'artistMemory'>[];
}>;

// Foreign keys point up this list, so inserting in order never violates one.
const ORDER = ['users', 'connections', 'jobs', 'jobAudience', 'artistMemory'] as const;

/** Inserts the given rows, parents before children; within a table, rows go in array order. */
export async function seed(rows: Seed): Promise<void> {
  for (const table of ORDER) {
    const values = rows[table];
    if (values?.length) await database.insert(schema[table]).values(values as never);
  }
}

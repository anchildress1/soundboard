// Stands in for $lib/server/core/db: unit tests (vitest.config.ts alias) and the E2E build
// (tests/e2e/fakes/db.ts) run real SQL on an in-process PGlite with the real migrations, so the
// database is never mocked. Each test file gets its own instance through module isolation.
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { resolve } from 'node:path';
import type { Database } from '$lib/server/core/db';
import * as schema from '$lib/server/core/schema';

// Resolved from the working directory, not this file: vitest and the Playwright web server both
// run from the repo root, and the E2E build bundles this module away from its source path.
const database = drizzle(new PGlite(), { schema });
await migrate(database, { migrationsFolder: resolve('drizzle') });

export function db(): Database {
  return database;
}

/** The instance lives for the whole test file; there is no pool to drop. */
export function resetDb(): void {}

type Insert<T extends keyof typeof schema> = (typeof schema)[T] extends {
  $inferInsert: infer Row;
}
  ? Row
  : never;

export type Seed = Partial<{
  invites: Insert<'invites'>[];
  users: Insert<'users'>[];
  connections: Insert<'connections'>[];
  jobs: Insert<'jobs'>[];
  jobPicks: Insert<'jobPicks'>[];
  jobChunks: Insert<'jobChunks'>[];
  jobFeedback: Insert<'jobFeedback'>[];
  artistFacts: Insert<'artistFacts'>[];
  artistFeedback: Insert<'artistFeedback'>[];
  artistPublishes: Insert<'artistPublishes'>[];
  artistBrand: Insert<'artistBrand'>[];
}>;

// Foreign keys point up this list, so inserting in order never violates one.
const ORDER = [
  'invites',
  'users',
  'connections',
  'jobs',
  'jobPicks',
  'jobChunks',
  'jobFeedback',
  'artistFacts',
  'artistFeedback',
  'artistPublishes',
  'artistBrand',
] as const;

/** Inserts the given rows, parents before children; within a table, rows go in array order. */
export async function seed(rows: Seed): Promise<void> {
  for (const table of ORDER) {
    const values = rows[table];
    if (values?.length) await database.insert(schema[table]).values(values as never);
  }
}

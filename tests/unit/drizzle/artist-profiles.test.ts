// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { db } from '#lib/server/core/db.js';
import * as schema from '#lib/server/core/schema.js';
import { jobRow } from '#lib/server/jobs/rows.js';
import { jobDoc } from '../../helpers/pipeline';

type Row = Record<string, unknown>;
const rows = async (
  database: { execute: (s: ReturnType<typeof sql>) => Promise<unknown> },
  s: ReturnType<typeof sql>,
) => ((await database.execute(s)) as { rows: Row[] }).rows;

const journal = JSON.parse(await readFile(resolve('drizzle/meta/_journal.json'), 'utf8')) as {
  entries: { tag: string }[];
};
const tags = journal.entries.map((entry) => entry.tag);

/** Applies one migration in a transaction, as drizzle's migrator does, split on its breakpoints. */
async function apply(pglite: PGlite, tag: string): Promise<void> {
  const file = await readFile(resolve('drizzle', `${tag}.sql`), 'utf8');
  await pglite.transaction(async (tx) => {
    for (const statement of file.split('--> statement-breakpoint')) {
      if (statement.trim()) await tx.exec(statement);
    }
  });
}

/** A database at the migration before artist profiles, seeded as production had it. */
async function before(artistId: string) {
  const pglite = new PGlite();
  for (const tag of tags.slice(0, tags.indexOf('0005_artist_profiles'))) await apply(pglite, tag);
  const database = drizzle(pglite, { schema });
  await database.insert(schema.users).values({ email: 'n@example.test', uid: 'sub-n', artistId });
  const picks = (...titles: string[]) =>
    titles.map((title, i) => ({ version: i + 1, title, modelMs: 1 }));
  const job = (id: string, artist: string | null, picked: object[]) => ({
    ...jobRow(jobDoc({ id, ownerUid: 'sub-n', artistId: artist })),
    picks: picked,
  });
  await database
    .insert(schema.jobs)
    .values([
      job('flr-job', artistId, picks('One', 'Two')),
      job('plain-job', null, picks('Solo')),
      job('empty-job', null, []),
    ]);
  await database.insert(schema.artistMemory).values([
    { artistId, kind: 'fact', key: 'artist-name', data: { value: 'Flies Like Robots' } },
    {
      artistId,
      kind: 'brand',
      key: 'approved',
      data: { statement: 's', basedOn: ['a', 'b', 'c'] },
    },
  ]);
  return { pglite, database };
}

// Runs on the shared migrated instance before any test truncates it.
describe('artist profiles migration', () => {
  it("seeds Nathan's curated profile with today's values", async () => {
    expect(
      await rows(db(), sql`select id, name, bandcamp_url, contact_line, curated from artists`),
    ).toEqual([
      {
        id: 'flr',
        name: 'Flies Like Robots',
        bandcamp_url: 'https://flieslikerobots.bandcamp.com',
        contact_line: 'Contact at flieslikerobots@gmail.com.',
        curated: true,
      },
    ]);
  });

  it('keeps the home and Mr. Kill facts and derives the artist name instead of storing it', async () => {
    expect(
      await rows(
        db(),
        sql`select key, data from artist_memory where artist_id = 'flr' order by key`,
      ),
    ).toEqual([
      { key: 'home', data: { key: 'home', value: 'Virginia', kind: 'FACT', public: true } },
      {
        key: 'mr-kill',
        data: {
          key: 'mr-kill',
          value: 'Connected to the artist Mr. Kill',
          kind: 'INFERENCE',
          public: false,
        },
      },
    ]);
  });

  it('backfills picks, brand rows and the fact, keeping the link', async () => {
    const { pglite, database } = await before('flr');
    await apply(pglite, '0005_artist_profiles');

    const jobs = await rows(database, sql`select id, picks from jobs order by id`);
    expect(jobs).toEqual([
      { id: 'empty-job', picks: [] },
      {
        id: 'flr-job',
        picks: [
          { version: 1, title: 'One', modelMs: 1, artistName: 'Flies Like Robots' },
          { version: 2, title: 'Two', modelMs: 1, artistName: 'Flies Like Robots' },
        ],
      },
      { id: 'plain-job', picks: [{ version: 1, title: 'Solo', modelMs: 1, artistName: null }] },
    ]);
    expect(
      await rows(database, sql`select key, data from artist_memory where kind = 'brand'`),
    ).toEqual([{ key: 'approved', data: { statement: 's', uploadCount: 3 } }]);
    expect(
      await rows(database, sql`select key from artist_memory where key = 'artist-name'`),
    ).toEqual([]);
    expect(await rows(database, sql`select uid, artist_id from users`)).toEqual([
      { uid: 'sub-n', artist_id: 'flr' },
    ]);
  });

  it('fails loud on any other artist link, changing nothing', async () => {
    const { pglite, database } = await before('other');
    await expect(apply(pglite, '0005_artist_profiles')).rejects.toMatchObject({ code: '23503' });
    expect(await rows(database, sql`select to_regclass('public.artists') as artists`)).toEqual([
      { artists: null },
    ]);
  });

  it('fails loud when two users link to the curated profile', async () => {
    const { pglite, database } = await before('flr');
    await database.insert(schema.users).values({ email: 'm@example.test', artistId: 'flr' });
    await expect(apply(pglite, '0005_artist_profiles')).rejects.toMatchObject({ code: '23505' });
  });
});

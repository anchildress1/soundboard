// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { client } from '../../helpers/db';
import { NATHAN_VOICE_RULES } from '../../helpers/voice';

type Row = Record<string, unknown>;

const journal = JSON.parse(await readFile(resolve('drizzle/meta/_journal.json'), 'utf8')) as {
  entries: { tag: string }[];
};
const tags = journal.entries.map((entry) => entry.tag);
const GUIDES = '0006_artist_guides';

/** Applies one migration in a transaction, as drizzle's migrator does, split on its breakpoints. */
async function apply(pglite: PGlite, tag: string): Promise<void> {
  const file = await readFile(resolve('drizzle', `${tag}.sql`), 'utf8');
  await pglite.transaction(async (tx) => {
    for (const statement of file.split('--> statement-breakpoint')) {
      if (statement.trim()) await tx.exec(statement);
    }
  });
}

const rows = async (pglite: PGlite, text: string) => (await pglite.query<Row>(text)).rows;

const APPROVED_BRAND = {
  statement: 'Plain titles.',
  keep: ['Song only'],
  fix: [],
  drop: ['Emoji'],
  status: 'APPROVED',
  uploadCount: 12,
  createdAt: Date.UTC(2026, 9, 1),
  approvedAt: Date.UTC(2026, 9, 2),
};

/** A database at the migration before artist guides, with 004's brand rows for Nathan. */
async function before() {
  const pglite = new PGlite();
  for (const tag of tags.slice(0, tags.indexOf(GUIDES))) await apply(pglite, tag);
  await pglite.query(
    `insert into artist_memory (artist_id, kind, key, data) values
      ('flr', 'brand', 'approved', $1), ('flr', 'brand', 'proposal', $2)`,
    [APPROVED_BRAND, { ...APPROVED_BRAND, status: 'PROPOSED', statement: 'Pending.' }],
  );
  return pglite;
}

// Runs on the shared migrated instance before any test truncates it.
describe('artist guides migration', () => {
  it("carries Nathan's 004 voice over as his approved voice, credit line last", async () => {
    expect(
      await rows(
        client(),
        `select artist_id, kind, status, body, sources, grant_at from artist_guides`,
      ),
    ).toEqual([
      {
        artist_id: 'flr',
        kind: 'voice',
        status: 'approved',
        body: { rules: NATHAN_VOICE_RULES },
        sources: { uploads: 0, drafts: 0, edits: 0, approvals: 0, carriedOver: true },
        grant_at: null,
      },
    ]);
  });

  it('copies the approved brand guide, drops every 004 brand row and the curated flag', async () => {
    const pglite = await before();
    await apply(pglite, GUIDES);

    expect(
      await rows(
        pglite,
        `select kind, body, sources, proposed_at, approved_at from artist_guides
          where kind = 'brand'`,
      ),
    ).toEqual([
      {
        kind: 'brand',
        body: { statement: 'Plain titles.', keep: ['Song only'], fix: [], drop: ['Emoji'] },
        sources: { uploads: 12, drafts: 0, edits: 0, approvals: 0, carriedOver: true },
        proposed_at: new Date(APPROVED_BRAND.createdAt),
        approved_at: new Date(APPROVED_BRAND.approvedAt),
      },
    ]);
    expect(await rows(pglite, `select kind from artist_memory where kind = 'brand'`)).toEqual([]);
    expect(
      await rows(
        pglite,
        `select column_name from information_schema.columns
          where table_name = 'artists' and column_name = 'curated'`,
      ),
    ).toEqual([]);
    await expect(
      pglite.query(`insert into artist_memory (artist_id, kind, key, data) values
        ('flr', 'brand', 'approved', '{}')`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('fails loud, changing nothing, unless exactly one profile is curated', async () => {
    const pglite = await before();
    await pglite.query(`update artists set curated = false`);
    await expect(apply(pglite, GUIDES)).rejects.toThrow('Expected one curated artist');
    expect(await rows(pglite, `select to_regclass('public.artist_guides') as guides`)).toEqual([
      { guides: null },
    ]);
    expect(
      await rows(pglite, `select count(*)::int as n from artist_memory where kind = 'brand'`),
    ).toEqual([{ n: 2 }]);
  });
});

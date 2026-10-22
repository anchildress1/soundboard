// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('genre evidence migration', () => {
  it('purges research with unknown retrieval age without deleting artist drafts or job details', async () => {
    const database = new PGlite();
    try {
      await database.exec(await readFile('drizzle/0000_init.sql', 'utf8'));
      await database.exec(
        "insert into users (email, uid) values ('artist@example.test', 'artist')",
      );
      const draft = [{ title: 'Artist title', description: 'Artist copy #rock', tags: ['rock'] }];
      await database.query(
        `insert into jobs (id, owner_uid, state, created_at, data, picks) values
          ('old', 'artist', 'REVIEW', now(), $1, $2)`,
        [
          JSON.stringify({
            songTitle: 'Song',
            audience: { top: [{ views: 123456 }], tags: [{ tag: 'rock', usedBy: 50 }] },
            hashtagCandidates: ['#rock', '#unused'],
          }),
          JSON.stringify(draft),
        ],
      );

      await database.exec(await readFile('drizzle/0001_genre_evidence_retention.sql', 'utf8'));

      const result = await database.query('select data, picks from jobs');
      expect(result.rows).toEqual([{ data: { songTitle: 'Song' }, picks: draft }]);
      expect((await database.query('select * from job_audience')).rows).toEqual([]);

      // The old app can still finish a pick between schema migration and traffic moving.
      await database.exec(`update jobs set data = data || '{"audience":{"views":123456}}'`);
      await database.exec(await readFile('drizzle/0002_reject_embedded_research.sql', 'utf8'));

      await expect(
        database.exec(`update jobs set data = data || '{"audience":{"views":123456}}'`),
      ).rejects.toThrow('jobs_research_external');
      await expect(
        database.exec(`insert into jobs (id, owner_uid, state, created_at, data) values
          ('legacy', 'artist', 'PICK', now(), '{"hashtagCandidates":["#rock"]}')`),
      ).rejects.toThrow('jobs_research_external');
      expect((await database.query('select data, picks from jobs')).rows).toEqual([
        { data: { songTitle: 'Song' }, picks: draft },
      ]);
    } finally {
      await database.close();
    }
  });
});

// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { load } from '#src/routes/+page.server.js';
import { seed, truncate } from '../../helpers/db';
import { A_JOB, seedJob, USER_A, USER_B, USERS } from '../../helpers/pipeline';

type Event = Parameters<typeof load>[0];

const run = async (user: Event['locals']['user']) =>
  (await load({ locals: { user } } as unknown as Event)) as { jobs: { id: string }[] };

beforeEach(async () => {
  await truncate();
  await seed(USERS);
  await seedJob({ id: 'a1', ...A_JOB, songTitle: 'PeekaBoo', state: 'REVIEW', createdAt: 5 });
  await seedJob({ id: 'b1', createdAt: 6 });
});

describe('home page load', () => {
  it("lists only the signed-in user's jobs with the list fields", async () => {
    expect((await run(USER_A)).jobs).toEqual([
      { id: 'a1', songTitle: 'PeekaBoo', state: 'REVIEW', createdAt: 5 },
    ]);
    expect((await run(USER_B)).jobs.map((j) => j.id)).toEqual(['b1']);
  });

  it('lists nothing when signed out', async () => {
    expect((await run(null)).jobs).toEqual([]);
  });
});

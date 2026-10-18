// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '$lib/server/core/db';
import { invites, users } from '$lib/server/core/schema';
import { add, list, reactivate, revoke, run, USAGE } from '../../../scripts/invite';
import { client, seed, truncate } from '../../helpers/db';
import { USER_A, USER_B, USERS } from '../../helpers/pipeline';

const inviteOf = async (email: string) =>
  (await db().select().from(invites).where(eq(invites.email, email)))[0];
const generationOf = async (uid: string) =>
  (await db().select().from(users).where(eq(users.uid, uid)))[0]!.accessGeneration;

beforeEach(async () => {
  await truncate();
  await seed(USERS);
});

describe('add', () => {
  it('invites a normalized email, unbound and active', async () => {
    await add(client(), '  New@Example.COM ', null);
    expect(await inviteOf('new@example.com')).toMatchObject({
      active: true,
      artistId: null,
      boundSub: null,
    });
  });

  it('links the invite to an artist', async () => {
    await add(client(), 'nathan@example.com', 'flr');
    expect((await inviteOf('nathan@example.com'))!.artistId).toBe('flr');
  });

  it('refuses a duplicate invite', async () => {
    await expect(add(client(), USER_A.email, null)).rejects.toThrow();
  });
});

describe('revoke', () => {
  it("deactivates the invite and bumps only the bound user's generation", async () => {
    await revoke(client(), USER_A.email.toUpperCase());
    expect((await inviteOf(USER_A.email))!.active).toBe(false);
    expect(await generationOf(USER_A.uid)).toBe(2);
    expect(await generationOf(USER_B.uid)).toBe(1);
  });

  it('revokes an unbound invite without touching any user', async () => {
    await add(client(), 'new@example.com', null);
    await revoke(client(), 'new@example.com');
    expect((await inviteOf('new@example.com'))!.active).toBe(false);
    expect([await generationOf(USER_A.uid), await generationOf(USER_B.uid)]).toEqual([1, 1]);
  });

  it('throws for an unknown email and leaves the transaction closed', async () => {
    await expect(revoke(client(), 'nobody@example.com')).rejects.toThrow(
      'No invite for nobody@example.com',
    );
    await revoke(client(), USER_B.email);
    expect(await generationOf(USER_B.uid)).toBe(2);
  });

  /** Fails every query `fails` matches; returns how many it failed. */
  async function failing(fails: (text: string) => boolean, body: () => Promise<void>) {
    const pg = client();
    const query = pg.query.bind(pg);
    let rejected = 0;
    const texts: string[] = [];
    const spy = vi.spyOn(pg, 'query').mockImplementation(((text: string, params?: unknown[]) => {
      texts.push(text);
      if (!fails(text)) return query(text, params);
      rejected += 1;
      return Promise.reject(new Error(`lost connection on ${text.split(' ')[0]}`));
    }) as typeof pg.query);
    try {
      await body();
    } finally {
      spy.mockRestore();
    }
    return { rejected, texts };
  }

  it('rolls back the deactivation when the generation bump fails', async () => {
    const { rejected, texts } = await failing(
      (text) => text.startsWith('update users'),
      () => expect(revoke(client(), USER_A.email)).rejects.toThrow('lost connection on update'),
    );
    expect(rejected).toBe(1);
    expect(texts.at(-1)).toBe('rollback');
    expect((await inviteOf(USER_A.email))!.active).toBe(true);
    expect(await generationOf(USER_A.uid)).toBe(1);
  });

  it('keeps the original error when the rollback fails too', async () => {
    let error: Error | undefined;
    const { rejected } = await failing(
      (text) => text.startsWith('update users') || text === 'rollback',
      async () => {
        await revoke(client(), USER_A.email).catch((e: unknown) => {
          error = e as Error;
        });
      },
    );
    expect(rejected).toBe(2);
    expect(error!.message).toBe(
      'lost connection on update (rollback also failed: lost connection on rollback)',
    );
    expect((error!.cause as Error).message).toBe('lost connection on update');
    await client().query('rollback');
  });

  it('returns the bound user, or null for an invite nobody used', async () => {
    expect(await revoke(client(), USER_A.email)).toBe(USER_A.uid);
    await add(client(), 'new@example.com', null);
    expect(await revoke(client(), 'new@example.com')).toBeNull();
  });
});

describe('reactivate', () => {
  it('reactivates the invite without lowering the generation', async () => {
    await revoke(client(), USER_A.email);
    await reactivate(client(), USER_A.email);
    expect((await inviteOf(USER_A.email))!.active).toBe(true);
    expect(await generationOf(USER_A.uid)).toBe(2);
  });

  it('throws for an unknown email', async () => {
    await expect(reactivate(client(), 'nobody@example.com')).rejects.toThrow('No invite');
  });
});

describe('list', () => {
  it('lists every invite by email', async () => {
    await revoke(client(), USER_B.email);
    expect(await list(client())).toEqual([
      { email: USER_A.email, active: true, artist_id: 'flr', bound_sub: USER_A.uid },
      { email: USER_B.email, active: false, artist_id: null, bound_sub: USER_B.uid },
    ]);
  });

  it('lists nothing when there are no invites', async () => {
    await truncate();
    expect(await list(client())).toEqual([]);
  });
});

describe('run', () => {
  it('adds, with or without an artist', async () => {
    expect(await run(['add', 'X@Example.com'], client())).toBe('Invited x@example.com');
    expect(await run(['add', 'y@example.com', '--artist', 'flr'], client())).toBe(
      'Invited y@example.com',
    );
    expect((await inviteOf('y@example.com'))!.artistId).toBe('flr');
  });

  it('revokes and reactivates', async () => {
    expect(await run(['revoke', USER_A.email], client())).toBe(`Revoked ${USER_A.email}`);
    expect(await run(['reactivate', USER_A.email], client())).toBe(`Reactivated ${USER_A.email}`);
  });

  it('says when a revoked invite was never used to sign in', async () => {
    await add(client(), 'new@example.com', null);
    expect(await run(['revoke', 'new@example.com'], client())).toBe(
      'Revoked new@example.com (never signed in)',
    );
  });

  it('prints one tab-separated line per invite', async () => {
    await run(['revoke', USER_B.email], client());
    expect(await run(['list'], client())).toBe(
      [
        [USER_A.email, 'active', 'flr', USER_A.uid].join('\t'),
        [USER_B.email, 'revoked', '-', USER_B.uid].join('\t'),
      ].join('\n'),
    );
  });

  it.each([
    [[]],
    [['add']],
    [['add', 'a@b.c', '--artist']],
    [['add', 'a@b.c', '--role', 'x']],
    [['add', 'a@b.c', '--artist', 'flr', 'extra']],
    [['revoke']],
    [['revoke', 'a@b.c', '--artist', 'flr']],
    [['list', 'extra']],
    [['delete', 'a@b.c']],
  ])('refuses %j with the usage line, writing nothing', async (args) => {
    const before = await list(client());
    await expect(run(args, client())).rejects.toThrow(USAGE);
    expect(await list(client())).toEqual(before);
  });
});

describe('scripts/invite.ts as a standalone script', () => {
  const SCRIPT = resolve('scripts/invite.ts');

  it('imports no app code, so plain Node can run it', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(/from '\$lib/);
    expect(source).not.toMatch(/from '\.\.?\//);
  });

  it('prints the usage line and exits 1 without arguments, before touching the database', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const result = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(USAGE);
    expect(result.stdout).toBe('');
  });
});

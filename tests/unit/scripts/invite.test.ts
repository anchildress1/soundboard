// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/core/db';
import { users } from '$lib/server/core/schema';
import { add, list, reactivate, revoke, run, USAGE } from '../../../scripts/invite';
import { client, seed, truncate } from '../../helpers/db';
import { USER_A, USER_B, USERS } from '../../helpers/pipeline';

const userOf = async (email: string) =>
  (await db().select().from(users).where(eq(users.email, email)))[0];

beforeEach(async () => {
  await truncate();
  await seed(USERS);
});

describe('add', () => {
  it('adds a normalized email, unbound and active', async () => {
    await add(client(), '  New@Example.COM ', null);
    expect(await userOf('new@example.com')).toMatchObject({
      active: true,
      artistId: null,
      uid: null,
    });
  });

  it('links the user to an artist', async () => {
    await add(client(), 'nathan@example.com', 'flr');
    expect((await userOf('nathan@example.com'))!.artistId).toBe('flr');
  });

  it('refuses a duplicate email, in any case', async () => {
    await expect(add(client(), USER_A.email.toUpperCase(), null)).rejects.toThrow();
  });
});

describe('revoke', () => {
  it('deactivates only that account, matching the email in any case', async () => {
    await revoke(client(), USER_A.email.toUpperCase());
    expect((await userOf(USER_A.email))!.active).toBe(false);
    expect((await userOf(USER_B.email))!.active).toBe(true);
  });

  it('keeps the bound uid and artist link', async () => {
    await revoke(client(), USER_A.email);
    expect(await userOf(USER_A.email)).toMatchObject({ uid: USER_A.uid, artistId: 'flr' });
  });

  it('is idempotent on an already revoked account', async () => {
    await revoke(client(), USER_A.email);
    expect(await revoke(client(), USER_A.email)).toBe(true);
    expect((await userOf(USER_A.email))!.active).toBe(false);
  });

  it('throws for an unknown email, writing nothing', async () => {
    const before = await list(client());
    await expect(revoke(client(), 'nobody@example.com')).rejects.toThrow(
      'No invite for nobody@example.com',
    );
    expect(await list(client())).toEqual(before);
  });

  it('returns whether the account ever signed in', async () => {
    expect(await revoke(client(), USER_A.email)).toBe(true);
    await add(client(), 'new@example.com', null);
    expect(await revoke(client(), 'new@example.com')).toBe(false);
  });
});

describe('reactivate', () => {
  it('reactivates the account, keeping its uid', async () => {
    await revoke(client(), USER_A.email);
    expect(await reactivate(client(), USER_A.email)).toBe(true);
    expect(await userOf(USER_A.email)).toMatchObject({ active: true, uid: USER_A.uid });
  });

  it('returns false for an account that never signed in', async () => {
    await add(client(), 'new@example.com', null);
    await revoke(client(), 'new@example.com');
    expect(await reactivate(client(), 'new@example.com')).toBe(false);
  });

  it('throws for an unknown email', async () => {
    await expect(reactivate(client(), 'nobody@example.com')).rejects.toThrow('No invite');
  });
});

describe('list', () => {
  it('lists every user by email', async () => {
    await revoke(client(), USER_B.email);
    await add(client(), 'c@example.com', null);
    expect(await list(client())).toEqual([
      { email: USER_A.email, active: true, artist_id: 'flr', uid: USER_A.uid },
      { email: USER_B.email, active: false, artist_id: null, uid: USER_B.uid },
      { email: 'c@example.com', active: true, artist_id: null, uid: null },
    ]);
  });

  it('lists nothing when there are no users', async () => {
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
    expect((await userOf('y@example.com'))!.artistId).toBe('flr');
  });

  it('revokes and reactivates', async () => {
    expect(await run(['revoke', USER_A.email], client())).toBe(`Revoked ${USER_A.email}`);
    expect(await run(['reactivate', USER_A.email], client())).toBe(`Reactivated ${USER_A.email}`);
  });

  it('says when a revoked account never signed in', async () => {
    await add(client(), 'new@example.com', null);
    expect(await run(['revoke', 'new@example.com'], client())).toBe(
      'Revoked new@example.com (never signed in)',
    );
  });

  it('prints one tab-separated line per user, with - for an unset artist or uid', async () => {
    await run(['revoke', USER_B.email], client());
    await add(client(), 'c@example.com', null);
    expect(await run(['list'], client())).toBe(
      [
        [USER_A.email, 'active', 'flr', USER_A.uid].join('\t'),
        [USER_B.email, 'revoked', '-', USER_B.uid].join('\t'),
        ['c@example.com', 'active', '-', '-'].join('\t'),
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

  it('asks for DATABASE_URL on a valid command line without it, never ending a client', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    // Preloaded on the pg the script resolves, so a call to end() shows up on stderr.
    const spy =
      `import { createRequire } from 'node:module';` +
      `createRequire(${JSON.stringify(SCRIPT)})('pg').Client.prototype.end = ` +
      `async () => { console.error('end called'); };`;
    const result = spawnSync(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(spy)}`, SCRIPT, 'list'],
      { env, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('Set DATABASE_URL');
    expect(result.stdout).toBe('');
  });
});

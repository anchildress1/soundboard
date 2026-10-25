// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { users } from '#lib/server/core/schema.js';
import { add, list, reactivate, revoke, run, USAGE } from '../../../scripts/invite';
import { client, seed, truncate } from '../../helpers/db';
import { USER_A, USER_B, USER_C, USERS } from '../../helpers/pipeline';

const userOf = async (email: string) =>
  (await db().select().from(users).where(eq(users.email, email)))[0];

/** A profile nobody is linked to yet, as Nathan's was before his first invite. */
const UNLINKED = 'artist-x';

beforeEach(async () => {
  await truncate();
  await seed({ ...USERS, artists: [...USERS.artists, { id: UNLINKED, name: 'X' }] });
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
    await add(client(), 'x@example.com', UNLINKED);
    expect((await userOf('x@example.com'))!.artistId).toBe(UNLINKED);
  });

  it('refuses a profile another user is already linked to', async () => {
    await expect(add(client(), 'x@example.com', USER_A.artistId)).rejects.toThrow();
    expect(await userOf('x@example.com')).toBeUndefined();
  });

  it('refuses a profile that does not exist', async () => {
    await expect(add(client(), 'x@example.com', 'nope')).rejects.toThrow();
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
    await add(client(), 'd@example.com', null);
    expect(await list(client())).toEqual([
      { email: USER_A.email, active: true, artist_id: 'flr', uid: USER_A.uid },
      { email: USER_B.email, active: false, artist_id: null, uid: USER_B.uid },
      { email: USER_C.email, active: true, artist_id: USER_C.artistId, uid: USER_C.uid },
      { email: 'd@example.com', active: true, artist_id: null, uid: null },
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
    expect(await run(['add', 'y@example.com', '--artist', UNLINKED], client())).toBe(
      'Invited y@example.com',
    );
    expect((await userOf('y@example.com'))!.artistId).toBe(UNLINKED);
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
    await add(client(), 'd@example.com', null);
    expect(await run(['list'], client())).toBe(
      [
        [USER_A.email, 'active', 'flr', USER_A.uid].join('\t'),
        [USER_B.email, 'revoked', '-', USER_B.uid].join('\t'),
        [USER_C.email, 'active', USER_C.artistId, USER_C.uid].join('\t'),
        ['d@example.com', 'active', '-', '-'].join('\t'),
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
    expect(source).not.toMatch(/from '#lib/);
    expect(source).not.toMatch(/from '\.\.?\//);
  });

  it('prints the usage line and exits 1 without arguments, before touching the database', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.DATABASE_URL_UNPOOLED;
    const result = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(USAGE);
    expect(result.stdout).toBe('');
  });

  it.each([undefined, 'postgres://app@runtime.test/runtime'])(
    'requires DATABASE_URL_UNPOOLED without falling back to DATABASE_URL %s',
    (runtimeUrl) => {
      const env = { ...process.env };
      delete env.DATABASE_URL_UNPOOLED;
      if (runtimeUrl) env.DATABASE_URL = runtimeUrl;
      else delete env.DATABASE_URL;
      // Preloaded on the pg the script resolves, so either lifecycle call fails the assertion.
      const spy =
        `import { createRequire } from 'node:module';` +
        `const { Client } = createRequire(${JSON.stringify(SCRIPT)})('pg');` +
        `Client.prototype.connect = async () => { throw new Error('connect called'); };` +
        `Client.prototype.end = ` +
        `async () => { console.error('end called'); };`;
      const result = spawnSync(
        process.execPath,
        ['--import', `data:text/javascript,${encodeURIComponent(spy)}`, SCRIPT, 'list'],
        { env, encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe('Set DATABASE_URL_UNPOOLED');
      expect(result.stdout).toBe('');
    },
  );

  it('uses the operator URL when both database credentials are present', () => {
    const spy =
      `import { createRequire } from 'node:module';` +
      `const { Client } = createRequire(${JSON.stringify(SCRIPT)})('pg');` +
      `Client.prototype.connect = async function () {` +
      `if (this.connectionParameters.host !== 'owner.test') throw new Error('Wrong database credential'); };` +
      `Client.prototype.query = async () => ({ rows: [] });` +
      `Client.prototype.end = async () => {};`;
    const result = spawnSync(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(spy)}`, SCRIPT, 'list'],
      {
        env: {
          ...process.env,
          DATABASE_URL: 'postgres://app@runtime.test/runtime',
          DATABASE_URL_UNPOOLED: 'postgres://operator@owner.test/operator',
        },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('\n');
  });
});

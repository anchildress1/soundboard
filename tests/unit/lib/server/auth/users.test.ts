// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { admit, getUser } from '#lib/server/auth/users.js';
import { db } from '#lib/server/core/db.js';
import { users } from '#lib/server/core/schema.js';
import { client, seed } from '../../../../helpers/db';

const NATHAN = 'sub-nathan';
const OTHER = 'sub-other';

const userOf = async (email: string) =>
  (await db().select().from(users).where(eq(users.email, email)))[0];
const allUsers = () => db().select().from(users);

beforeEach(async () => {
  vi.stubEnv('SIGNUP_MODE', 'invite');
  await db().execute(sql`truncate users cascade`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('admit (invite mode)', () => {
  it('binds a first sign-in by normalized email and keeps the artist link', async () => {
    await seed({ users: [{ email: 'nathan@example.com', artistId: 'flr' }] });
    expect(await admit(NATHAN, '  Nathan@Example.COM ')).toMatchObject({
      uid: NATHAN,
      email: 'nathan@example.com',
      artistId: 'flr',
      active: true,
    });
    expect((await userOf('nathan@example.com'))!.uid).toBe(NATHAN);
  });

  it('admits a returning user whose Google email changed, by uid', async () => {
    await seed({ users: [{ email: 'nathan@example.com', uid: NATHAN, artistId: 'flr' }] });
    expect(await admit(NATHAN, 'nathan@new.example')).toMatchObject({
      uid: NATHAN,
      email: 'nathan@example.com',
      artistId: 'flr',
    });
    expect(await allUsers()).toHaveLength(1);
  });

  it('denies another account on a bound email and writes nothing', async () => {
    await seed({ users: [{ email: 'nathan@example.com', uid: NATHAN }] });
    expect(await admit(OTHER, 'nathan@example.com')).toBe('denied');
    expect((await userOf('nathan@example.com'))!.uid).toBe(NATHAN);
  });

  it('denies a deactivated email and leaves it unbound', async () => {
    await seed({ users: [{ email: 'nathan@example.com', active: false }] });
    expect(await admit(NATHAN, 'nathan@example.com')).toBe('denied');
    expect((await userOf('nathan@example.com'))!.uid).toBeNull();
  });

  it('denies a returning user once deactivated', async () => {
    await seed({ users: [{ email: 'nathan@example.com', uid: NATHAN, active: false }] });
    expect(await admit(NATHAN, 'nathan@example.com')).toBe('denied');
  });

  it('admits a returning user again once reactivated', async () => {
    await seed({ users: [{ email: 'nathan@example.com', uid: NATHAN, active: false }] });
    await db().update(users).set({ active: true }).where(eq(users.uid, NATHAN));
    expect(await admit(NATHAN, 'nathan@example.com')).toMatchObject({ uid: NATHAN });
  });

  it("denies a deactivated user who signs in with another active row's email", async () => {
    await seed({
      users: [
        { email: 'old@example.com', uid: NATHAN, active: false },
        { email: 'new@example.com' },
      ],
    });
    expect(await admit(NATHAN, 'new@example.com')).toBe('denied');
    expect((await userOf('new@example.com'))!.uid).toBeNull();
  });

  it('denies an email with no row and writes nothing', async () => {
    expect(await admit(NATHAN, 'stranger@example.com')).toBe('denied');
    expect(await allUsers()).toEqual([]);
  });

  it('throws on an unknown SIGNUP_MODE before writing', async () => {
    vi.stubEnv('SIGNUP_MODE', 'everyone');
    await seed({ users: [{ email: 'nathan@example.com' }] });
    await expect(admit(NATHAN, 'nathan@example.com')).rejects.toThrow(/SIGNUP_MODE/);
    expect((await userOf('nathan@example.com'))!.uid).toBeNull();
  });
});

describe('admit (open mode)', () => {
  beforeEach(() => {
    vi.stubEnv('SIGNUP_MODE', 'open');
  });

  it('creates and binds a row for an unknown email, with no artist link', async () => {
    expect(await admit(OTHER, 'Anyone@Example.com')).toMatchObject({
      uid: OTHER,
      email: 'anyone@example.com',
      artistId: null,
      active: true,
    });
    expect(await allUsers()).toHaveLength(1);
  });

  it('binds an existing unbound row, keeping its artist link', async () => {
    await seed({ users: [{ email: 'anyone@example.com', artistId: 'flr' }] });
    expect(await admit(OTHER, 'anyone@example.com')).toMatchObject({ uid: OTHER, artistId: 'flr' });
    expect(await allUsers()).toHaveLength(1);
  });

  it('still denies a deactivated email, leaving it unbound', async () => {
    await seed({ users: [{ email: 'anyone@example.com', active: false }] });
    expect(await admit(OTHER, 'anyone@example.com')).toBe('denied');
    expect(await userOf('anyone@example.com')).toMatchObject({ uid: null, active: false });
  });

  it('still denies another account on a bound email', async () => {
    await seed({ users: [{ email: 'anyone@example.com', uid: NATHAN }] });
    expect(await admit(OTHER, 'anyone@example.com')).toBe('denied');
    expect((await userOf('anyone@example.com'))!.uid).toBe(NATHAN);
  });

  it('returns a bound user unchanged', async () => {
    await seed({ users: [{ email: 'a@example.com', uid: OTHER }] });
    expect(await admit(OTHER, 'b@example.com')).toMatchObject({ email: 'a@example.com' });
    expect(await allUsers()).toHaveLength(1);
  });
});

describe('admit: concurrent first sign-ins of one account', () => {
  // A returning sign-in must not rewrite the account's first binding.
  beforeEach(async () => {
    await db().execute(sql`create temp table binds (uid text)`);
    await db().execute(
      sql.raw(`create or replace function count_binds() returns trigger language plpgsql as $$ begin
        insert into binds values (new.uid);
        return new;
      end $$`),
    );
    await db().execute(
      sql`create trigger count_binds after update on users for each row execute function count_binds()`,
    );
  });

  afterEach(async () => {
    await db().execute(sql`drop trigger if exists count_binds on users`);
    await db().execute(sql`drop table if exists binds`);
  });

  const binds = async () => (await client().query('select uid from binds')).rows;

  it('admits both, in invite mode', async () => {
    await seed({ users: [{ email: 'nathan@example.com', artistId: 'flr' }] });
    const results = await Promise.all([
      admit(NATHAN, 'nathan@example.com'),
      admit(NATHAN, 'nathan@example.com'),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ uid: NATHAN, artistId: 'flr' }),
      expect.objectContaining({ uid: NATHAN, artistId: 'flr' }),
    ]);
    expect(await binds()).toEqual([{ uid: NATHAN }]);
    expect(await allUsers()).toHaveLength(1);
  });

  it('admits both, in open mode', async () => {
    vi.stubEnv('SIGNUP_MODE', 'open');
    const results = await Promise.all([
      admit(OTHER, 'anyone@example.com'),
      admit(OTHER, 'anyone@example.com'),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ uid: OTHER }),
      expect.objectContaining({ uid: OTHER }),
    ]);
    expect(await binds()).toEqual([{ uid: OTHER }]);
    expect(await allUsers()).toHaveLength(1);
  });

  it('admits only the first of two different accounts racing for one email', async () => {
    await seed({ users: [{ email: 'nathan@example.com' }] });
    const results = await Promise.all([
      admit(NATHAN, 'nathan@example.com'),
      admit(OTHER, 'nathan@example.com'),
    ]);
    expect(results).toEqual([expect.objectContaining({ uid: NATHAN }), 'denied']);
    expect((await userOf('nathan@example.com'))!.uid).toBe(NATHAN);
  });
});

describe('getUser', () => {
  it('returns the active user bound to the uid', async () => {
    await seed({ users: [{ email: 'nathan@example.com', uid: NATHAN, artistId: 'flr' }] });
    expect(await getUser(NATHAN)).toMatchObject({
      uid: NATHAN,
      email: 'nathan@example.com',
      artistId: 'flr',
    });
  });

  it("joins the user's linked profile, as migration 0005 seeds Nathan's", async () => {
    await seed({ users: [{ email: 'nathan@example.com', uid: NATHAN, artistId: 'flr' }] });
    expect((await getUser(NATHAN))!.artist).toEqual({
      id: 'flr',
      name: 'Flies Like Robots',
      bandcampUrl: 'https://flieslikerobots.bandcamp.com',
      contactLine: 'Contact at flieslikerobots@gmail.com.',
    });
  });

  it('returns a null artist for a user with no profile', async () => {
    await seed({ users: [{ email: 'b@example.com', uid: OTHER }] });
    expect((await getUser(OTHER))!.artist).toBeNull();
  });

  it('returns null for a deactivated user', async () => {
    await seed({ users: [{ email: 'nathan@example.com', uid: NATHAN, active: false }] });
    expect(await getUser(NATHAN)).toBeNull();
  });

  it('returns null for an unknown uid', async () => {
    await seed({ users: [{ email: 'nathan@example.com' }] });
    expect(await getUser('nobody')).toBeNull();
  });
});

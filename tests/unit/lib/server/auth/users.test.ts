// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUser, redeemInvite, updateProfile } from '$lib/server/auth/users';
import { db } from '$lib/server/core/db';
import { invites, users } from '$lib/server/core/schema';
import { seed } from '../../../../helpers/db';

const NATHAN = 'sub-nathan';
const OTHER = 'sub-other';

const invite = async (email: string) =>
  (
    await db()
      .select()
      .from(invites)
      .where(sql`${invites.email} = ${email}`)
  )[0];
const allUsers = () => db().select().from(users);

beforeEach(async () => {
  vi.stubEnv('SIGNUP_MODE', 'invite');
  await db().execute(sql`truncate users, invites cascade`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('redeemInvite (invite mode)', () => {
  it('binds a first redemption by normalized email and copies the artist link', async () => {
    await seed({ invites: [{ email: 'nathan@example.com', artistId: 'flr' }] });
    const user = await redeemInvite(NATHAN, '  Nathan@Example.COM ');
    expect(user).toMatchObject({
      uid: NATHAN,
      email: '  Nathan@Example.COM ',
      inviteEmail: 'nathan@example.com',
      artistId: 'flr',
      accessGeneration: 1,
    });
    expect((await invite('nathan@example.com'))!.boundSub).toBe(NATHAN);
  });

  it('admits a returning user whose Google email changed, by the invite they redeemed', async () => {
    await seed({
      invites: [{ email: 'nathan@example.com', artistId: 'flr', boundSub: NATHAN }],
      users: [
        {
          uid: NATHAN,
          email: 'nathan@example.com',
          inviteEmail: 'nathan@example.com',
          artistId: 'flr',
        },
      ],
    });
    const user = await redeemInvite(NATHAN, 'nathan@new.example');
    expect(user).toMatchObject({ uid: NATHAN, inviteEmail: 'nathan@example.com', artistId: 'flr' });
    expect(await allUsers()).toHaveLength(1);
  });

  it('keeps a returning user on their own artist link after the invite changes', async () => {
    await seed({
      invites: [{ email: 'nathan@example.com', artistId: 'other', boundSub: NATHAN }],
      users: [
        { uid: NATHAN, email: 'n@example.com', inviteEmail: 'nathan@example.com', artistId: 'flr' },
      ],
    });
    expect(await redeemInvite(NATHAN, 'n@example.com')).toMatchObject({ artistId: 'flr' });
  });

  it('denies a foreign sub on a bound invite and writes nothing', async () => {
    await seed({ invites: [{ email: 'nathan@example.com', artistId: 'flr', boundSub: NATHAN }] });
    expect(await redeemInvite(OTHER, 'nathan@example.com')).toBe('denied');
    expect(await allUsers()).toEqual([]);
    expect((await invite('nathan@example.com'))!.boundSub).toBe(NATHAN);
  });

  it('denies an inactive invite and leaves it unbound', async () => {
    await seed({ invites: [{ email: 'nathan@example.com', active: false }] });
    expect(await redeemInvite(NATHAN, 'nathan@example.com')).toBe('denied');
    expect(await allUsers()).toEqual([]);
    expect((await invite('nathan@example.com'))!.boundSub).toBeNull();
  });

  it('denies an email with no invite', async () => {
    expect(await redeemInvite(NATHAN, 'stranger@example.com')).toBe('denied');
    expect(await allUsers()).toEqual([]);
  });

  it('denies a returning user once their invite is revoked', async () => {
    await seed({
      invites: [{ email: 'nathan@example.com', active: false, boundSub: NATHAN }],
      users: [{ uid: NATHAN, email: 'nathan@example.com', inviteEmail: 'nathan@example.com' }],
    });
    expect(await redeemInvite(NATHAN, 'nathan@example.com')).toBe('denied');
  });

  it("denies a returning user by their own invite, not another invite for the token's email", async () => {
    await seed({
      invites: [
        { email: 'old@example.com', active: false, boundSub: NATHAN },
        { email: 'new@example.com' },
      ],
      users: [{ uid: NATHAN, email: 'old@example.com', inviteEmail: 'old@example.com' }],
    });
    expect(await redeemInvite(NATHAN, 'new@example.com')).toBe('denied');
    expect((await invite('new@example.com'))!.boundSub).toBeNull();
  });

  it('denies a user created under open signup once invites are back on', async () => {
    await seed({
      invites: [{ email: 'open@example.com' }],
      users: [{ uid: OTHER, email: 'open@example.com', inviteEmail: null }],
    });
    expect(await redeemInvite(OTHER, 'open@example.com')).toBe('denied');
    expect((await invite('open@example.com'))!.boundSub).toBeNull();
  });

  it('throws on an unknown SIGNUP_MODE before touching the database', async () => {
    vi.stubEnv('SIGNUP_MODE', 'everyone');
    await seed({ invites: [{ email: 'nathan@example.com' }] });
    await expect(redeemInvite(NATHAN, 'nathan@example.com')).rejects.toThrow(/SIGNUP_MODE/);
    expect(await allUsers()).toEqual([]);
  });
});

describe('redeemInvite (open mode)', () => {
  beforeEach(() => {
    vi.stubEnv('SIGNUP_MODE', 'open');
  });

  it('creates an uninvited user with no invite and no artist link', async () => {
    expect(await redeemInvite(OTHER, 'Anyone@Example.com')).toMatchObject({
      uid: OTHER,
      email: 'Anyone@Example.com',
      inviteEmail: null,
      artistId: null,
      accessGeneration: 1,
    });
  });

  it('ignores invites, binding none', async () => {
    await seed({ invites: [{ email: 'anyone@example.com', artistId: 'flr' }] });
    expect(await redeemInvite(OTHER, 'anyone@example.com')).toMatchObject({ artistId: null });
    expect((await invite('anyone@example.com'))!.boundSub).toBeNull();
  });

  it('returns an existing user unchanged', async () => {
    await seed({ users: [{ uid: OTHER, email: 'a@example.com', accessGeneration: 4 }] });
    expect(await redeemInvite(OTHER, 'b@example.com')).toMatchObject({
      email: 'a@example.com',
      accessGeneration: 4,
    });
    expect(await allUsers()).toHaveLength(1);
  });
});

describe('redeemInvite: concurrent first sign-ins of one account', () => {
  // Lands another sign-in's insert of the same account between this one's read and its insert.
  const raceFirstSignIn = async () => {
    await db().execute(
      sql.raw(`create or replace function race_users() returns trigger language plpgsql as $$ begin
        if pg_trigger_depth() = 1 then
          insert into users (uid, email, invite_email, artist_id, access_generation)
          values (new.uid, new.email, new.invite_email, new.artist_id, 1);
        end if;
        return new;
      end $$`),
    );
    await db().execute(
      sql`create trigger race_users before insert on users for each row execute function race_users()`,
    );
  };

  afterEach(async () => {
    await db().execute(sql`drop trigger if exists race_users on users`);
  });

  it('returns the user the other sign-in created, in open mode', async () => {
    vi.stubEnv('SIGNUP_MODE', 'open');
    await raceFirstSignIn();
    expect(await redeemInvite(OTHER, 'anyone@example.com')).toMatchObject({ uid: OTHER });
    expect(await allUsers()).toHaveLength(1);
  });

  it('returns the user the other sign-in created, in invite mode', async () => {
    await seed({ invites: [{ email: 'nathan@example.com', artistId: 'flr' }] });
    await raceFirstSignIn();
    expect(await redeemInvite(NATHAN, 'nathan@example.com')).toMatchObject({
      uid: NATHAN,
      artistId: 'flr',
    });
    expect(await allUsers()).toHaveLength(1);
  });
});

describe('getUser', () => {
  it('returns the user by uid', async () => {
    await seed({ users: [{ uid: NATHAN, email: 'nathan@example.com', name: 'Nathan' }] });
    expect(await getUser(NATHAN)).toMatchObject({ uid: NATHAN, name: 'Nathan' });
  });

  it('returns null for an unknown uid', async () => {
    expect(await getUser('nobody')).toBeNull();
  });
});

describe('updateProfile', () => {
  it('updates email and name and leaves accessGeneration untouched', async () => {
    await seed({ users: [{ uid: NATHAN, email: 'old@example.com', accessGeneration: 3 }] });
    const user = await updateProfile(NATHAN, { email: 'new@example.com', name: 'Nathan' });
    expect(user).toMatchObject({ email: 'new@example.com', name: 'Nathan', accessGeneration: 3 });
    expect(await getUser(NATHAN)).toMatchObject({ accessGeneration: 3 });
  });

  it('clears a name the token no longer carries', async () => {
    await seed({ users: [{ uid: NATHAN, email: 'n@example.com', name: 'Nathan' }] });
    expect(await updateProfile(NATHAN, { email: 'n@example.com', name: null })).toMatchObject({
      name: null,
    });
  });

  it('never creates a user', async () => {
    expect(await updateProfile('nobody', { email: 'x@example.com', name: null })).toBeNull();
    expect(await allUsers()).toEqual([]);
  });
});

// Manages the users allowlist using the operator credential in DATABASE_URL_UNPOOLED:
//   node --env-file=.env scripts/invite.ts add <email> [--artist flr]
//   node --env-file=.env scripts/invite.ts revoke <email>
//   node --env-file=.env scripts/invite.ts reactivate <email>
//   node --env-file=.env scripts/invite.ts list
// Standalone on purpose: no $lib imports, only syntax Node's type stripping can run.
import pg from 'pg';

/** Anything with pg's `query(text, params)`: a pg Client, or PGlite in tests. */
export type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export type Invite = {
  email: string;
  active: boolean;
  artist_id: string | null;
  uid: string | null;
};

export const USAGE =
  'Usage: node scripts/invite.ts add <email> [--artist <id>] | revoke <email> | reactivate <email> | list';

// Sign-in matches on the lowercased, trimmed email.
const normalize = (email: string) => email.trim().toLowerCase();

export async function add(db: Queryable, email: string, artistId: string | null): Promise<void> {
  await db.query('insert into users (email, artist_id) values ($1, $2)', [
    normalize(email),
    artistId,
  ]);
}

/**
 * Sets the account's `active` flag; deactivating signs it out on its next request. Returns
 * whether it ever signed in. Throws for an unknown email.
 */
async function setActive(db: Queryable, email: string, active: boolean): Promise<boolean> {
  const { rows } = await db.query('update users set active = $2 where email = $1 returning uid', [
    normalize(email),
    active,
  ]);
  const user = rows[0] as Pick<Invite, 'uid'> | undefined;
  if (!user) throw new Error(`No invite for ${email}`);
  return user.uid !== null;
}

export const revoke = (db: Queryable, email: string) => setActive(db, email, false);
export const reactivate = (db: Queryable, email: string) => setActive(db, email, true);

export async function list(db: Queryable): Promise<Invite[]> {
  const { rows } = await db.query('select email, active, artist_id, uid from users order by email');
  return rows as Invite[];
}

export type Command =
  | { name: 'list' }
  | { name: 'add'; email: string; artistId: string | null }
  | { name: 'revoke' | 'reactivate'; email: string };

/** Parses argv into a command; a bad command line throws `USAGE`. */
export function parse(args: string[]): Command {
  const [name, email, flag, artist, ...rest] = args;
  if (name === 'list' && !email) return { name };
  if (!email || rest.length > 0) throw new Error(USAGE);
  if (name === 'add' && (flag === undefined || (flag === '--artist' && artist))) {
    return { name, email, artistId: artist ?? null };
  }
  if (flag !== undefined) throw new Error(USAGE);
  if (name === 'revoke' || name === 'reactivate') return { name, email };
  throw new Error(USAGE);
}

/** Runs one command line and returns what to print; a bad command line throws `USAGE`. */
export async function run(args: string[], db: Queryable): Promise<string> {
  const command = parse(args);
  switch (command.name) {
    case 'list':
      return (await list(db))
        .map((r) =>
          [r.email, r.active ? 'active' : 'revoked', r.artist_id ?? '-', r.uid ?? '-'].join('\t'),
        )
        .join('\n');
    case 'add':
      await add(db, command.email, command.artistId);
      return `Invited ${normalize(command.email)}`;
    case 'revoke': {
      const signedIn = await revoke(db, command.email);
      return `Revoked ${normalize(command.email)}${signedIn ? '' : ' (never signed in)'}`;
    }
    case 'reactivate':
      await reactivate(db, command.email);
      return `Reactivated ${normalize(command.email)}`;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
  let connected = false;
  try {
    // Parse first: a bad command line prints usage even without DATABASE_URL_UNPOOLED.
    parse(args);
    if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('Set DATABASE_URL_UNPOOLED');
    await client.connect();
    connected = true;
    console.log(await run(args, client));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    if (connected) await client.end();
  }
}

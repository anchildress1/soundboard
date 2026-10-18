// Manages invites against DATABASE_URL (the unpooled URL works too):
//   node scripts/invite.ts add <email> [--artist flr]
//   node scripts/invite.ts revoke <email>
//   node scripts/invite.ts reactivate <email>
//   node scripts/invite.ts list
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
  bound_sub: string | null;
};

export const USAGE =
  'Usage: node scripts/invite.ts add <email> [--artist <id>] | revoke <email> | reactivate <email> | list';

// Sign-in matches invites on the lowercased, trimmed email.
const normalize = (email: string) => email.trim().toLowerCase();

export async function add(db: Queryable, email: string, artistId: string | null): Promise<void> {
  await db.query('insert into invites (email, artist_id) values ($1, $2)', [
    normalize(email),
    artistId,
  ]);
}

/** Deactivates the invite and signs its bound user out everywhere, in one transaction. */
export async function revoke(db: Queryable, email: string): Promise<void> {
  await db.query('begin');
  try {
    const { rows } = await db.query(
      'update invites set active = false where email = $1 returning bound_sub',
      [normalize(email)],
    );
    const invite = rows[0] as Pick<Invite, 'bound_sub'> | undefined;
    if (!invite) throw new Error(`No invite for ${email}`);
    await db.query('update users set access_generation = access_generation + 1 where uid = $1', [
      invite.bound_sub,
    ]);
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

/** Lets the account sign in again. Old sessions stay dead: the generation never goes back. */
export async function reactivate(db: Queryable, email: string): Promise<void> {
  const { rows } = await db.query(
    'update invites set active = true where email = $1 returning email',
    [normalize(email)],
  );
  if (rows.length === 0) throw new Error(`No invite for ${email}`);
}

export async function list(db: Queryable): Promise<Invite[]> {
  const { rows } = await db.query(
    'select email, active, artist_id, bound_sub from invites order by email',
  );
  return rows as Invite[];
}

/** Runs one command line and returns what to print; a bad command line throws `USAGE`. */
export async function run(args: string[], db: Queryable): Promise<string> {
  const [command, email, flag, artist, ...rest] = args;
  if (command === 'list' && !email) {
    const rows = await list(db);
    return rows
      .map((r) =>
        [r.email, r.active ? 'active' : 'revoked', r.artist_id ?? '-', r.bound_sub ?? '-'].join(
          '\t',
        ),
      )
      .join('\n');
  }
  if (!email || rest.length > 0) throw new Error(USAGE);
  if (command === 'add' && (flag === undefined || (flag === '--artist' && artist))) {
    await add(db, email, artist ?? null);
    return `Invited ${normalize(email)}`;
  }
  if (flag !== undefined) throw new Error(USAGE);
  if (command === 'revoke') {
    await revoke(db, email);
    return `Revoked ${normalize(email)}`;
  }
  if (command === 'reactivate') {
    await reactivate(db, email);
    return `Reactivated ${normalize(email)}`;
  }
  throw new Error(USAGE);
}

if (import.meta.main) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL');
    await client.connect();
    console.log(await run(process.argv.slice(2), client));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

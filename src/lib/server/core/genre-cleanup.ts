export const DELETE_EXPIRED_GENRE_EVIDENCE =
  "delete from job_audience where retrieved_at <= now() - interval '30 days' returning job_id";

/** Hidden from the app at 29 days, so a daily run deletes each proposal before it is 30 days old. */
export const DELETE_EXPIRED_PROPOSALS =
  "delete from artist_guides where status = 'proposed' and proposed_at <= now() - interval '29 days' returning id";

export const CHECK_CLEANUP_ROLE = `
  select current_user = 'soundboard_cleanup' and session_user = 'soundboard_cleanup'
    and not (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication)
    and not exists (select 1 from pg_catalog.pg_auth_members m where m.member = r.oid)
    and not exists (select 1 from pg_catalog.pg_shdepend d
      where d.refclassid = 'pg_catalog.pg_authid'::regclass
        and d.refobjid = r.oid and d.deptype = 'o') as allowed
  from pg_catalog.pg_roles r where r.rolname = current_user
`;

export type CleanupConnection = {
  connect(): Promise<unknown>;
  query(statement: string): Promise<{ rows: unknown[] }>;
  end(): Promise<unknown>;
};

/** Handles only invocations authenticated by Neon's hosting edge. */
export async function handleGenreCleanup(
  request: Request,
  connection: () => CleanupConnection,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  // Neon strips client-supplied X-Neon-* headers before adding its trigger identity.
  if (!request.headers.get('X-Neon-Trigger-Invocation-Id')) {
    return new Response('Forbidden', { status: 403 });
  }
  let client: CleanupConnection | undefined;
  let response: Response;
  try {
    client = connection();
    await client.connect();
    const role = await client.query(CHECK_CLEANUP_ROLE);
    if ((role.rows[0] as { allowed?: unknown } | undefined)?.allowed !== true)
      throw new Error('Cleanup requires the unprivileged soundboard_cleanup login.');
    const evidence = await client.query(DELETE_EXPIRED_GENRE_EVIDENCE);
    const proposals = await client.query(DELETE_EXPIRED_PROPOSALS);
    response = Response.json({ deleted: evidence.rows.length, proposals: proposals.rows.length });
  } catch {
    response = new Response('Genre evidence cleanup failed', { status: 500 });
  }
  try {
    await client?.end();
  } catch {
    response = new Response('Genre evidence cleanup connection failed', { status: 500 });
  }
  return response;
}

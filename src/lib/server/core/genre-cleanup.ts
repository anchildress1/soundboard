export const DELETE_EXPIRED_GENRE_EVIDENCE =
  "delete from job_audience where retrieved_at <= now() - interval '30 days' returning job_id";

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
    const result = await client.query(DELETE_EXPIRED_GENRE_EVIDENCE);
    response = Response.json({ deleted: result.rows.length });
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

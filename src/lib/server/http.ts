import { json } from '@sveltejs/kit';
import { ActionError } from './actions';

/** Runs a route body, turning expected `ActionError`s into JSON error responses. */
export async function respond(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await fn());
  } catch (error) {
    if (error instanceof ActionError) {
      return json({ error: error.message, fields: error.fields ?? null }, { status: error.status });
    }
    throw error;
  }
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body))
      return body as Record<string, unknown>;
  } catch {
    // Falls through to the error below.
  }
  throw new ActionError(400, 'Expected a JSON object.');
}

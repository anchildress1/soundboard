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

/** A JSON body field as text: a string as is, a number in decimal, anything else `fallback`. */
export function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

/** A JSON body field as a number: a JSON number as is, anything else NaN for validation to refuse. */
export const num = (value: unknown): number => (typeof value === 'number' ? value : Number.NaN);

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

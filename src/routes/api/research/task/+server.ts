import { OAuth2Client } from 'google-auth-library';
import { researchQueue } from '#lib/server/core/env.js';
import { runDelivery } from '#lib/server/research/delivery.js';
import type { Delivery } from '#lib/server/research/runs.js';
import type { RequestHandler } from './$types';

let verifier: OAuth2Client | undefined;

/**
 * Whether the request carries a Google OIDC ID token minted by Cloud Tasks for the research service
 * account. The service is public, so Cloud Run IAM can't make this check (research R2 step 1).
 */
async function fromQueue(authorization: string | null): Promise<boolean> {
  const config = researchQueue();
  const idToken = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
  if (!config || !idToken) return false;
  verifier ??= new OAuth2Client();
  try {
    const ticket = await verifier.verifyIdToken({ idToken, audience: config.url });
    const payload = ticket.getPayload();
    return payload?.email === config.serviceAccount && payload.email_verified === true;
  } catch {
    // A bad signature, expiry or audience: all the same 401.
    return false;
  }
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function delivery(body: unknown): Delivery | null {
  if (!body || typeof body !== 'object') return null;
  const { jobId, uid, runId, seq } = body as Record<string, unknown>;
  if (!text(jobId) || !text(uid) || !text(runId)) return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;
  return { jobId, uid, runId, seq };
}

/** Cloud Tasks only: runs one research batch. The body never carries run contents or errors. */
export const POST: RequestHandler = async ({ request }) => {
  if (!(await fromQueue(request.headers.get('authorization')))) {
    return new Response(null, { status: 401 });
  }
  const parsed = delivery(await request.json().catch(() => null));
  if (!parsed) return new Response(null, { status: 400 });
  const status = await runDelivery(parsed);
  return status === 200 ? Response.json({}) : new Response(null, { status });
};

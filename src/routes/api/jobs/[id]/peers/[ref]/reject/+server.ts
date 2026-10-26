import { error } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { artistJob } from '#lib/server/artist/memory.js';
import { query } from '#lib/server/core/db.js';
import { ActionError } from '#lib/server/core/errors.js';
import { respond } from '#lib/server/core/http.js';
import { latestPick } from '#lib/server/jobs/jobs.js';
import { authorizedJob } from '#lib/server/jobs/view.js';
import { readEvidence } from '#lib/server/research/evidence.js';
import type { RequestHandler } from './$types';

const EXPIRED = "That peer's evidence has expired. Reload to see it.";

/** Records "Not a peer" for one of the pick's peers; later research skips its channel. */
export const POST: RequestHandler = ({ params, locals }) =>
  respond(async () => {
    const job = await authorizedJob(params.id, locals.user?.uid);
    // A job whose owner has since relinked has no artist memory to write to.
    if (!(await artistJob(job))) error(404, 'Job not found');
    const pick = await latestPick(job.id);
    const stored = pick?.researchRunId ? await readEvidence(pick.researchRunId) : null;
    const peer = stored?.evidence.peers.find((candidate) => candidate.ref === params.ref);
    if (!peer) throw new ActionError(409, EXPIRED);
    await query((tx) => tx.execute(sql`select public.soundboard_reject_peer(${peer.channelId})`));
    return { rejected: peer.ref };
  });

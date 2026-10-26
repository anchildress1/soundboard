import { error } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { artistJob } from '#lib/server/artist/memory.js';
import { query } from '#lib/server/core/db.js';
import { ActionError, pgCode } from '#lib/server/core/errors.js';
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
    if (job.artistId === null) error(404, 'Job not found');
    const pick = await latestPick(job.id);
    const stored = pick?.researchRunId ? await readEvidence(pick.researchRunId) : null;
    const peer = stored?.evidence.peers.find((candidate) => candidate.ref === params.ref);
    if (!peer) throw new ActionError(409, EXPIRED);
    try {
      await query(async (tx) => {
        // The write locks the owner's row, so the link checked after it can't change before the
        // commit; a job whose owner has since relinked rolls the rejection back.
        await tx.execute(sql`select public.soundboard_reject_peer(${peer.channelId})`);
        if (!(await artistJob(job, tx))) error(404, 'Job not found');
      });
    } catch (error_) {
      // 42501: the owner has no artist any more.
      if (pgCode(error_) === '42501') error(404, 'Job not found');
      throw error_;
    }
    return { rejected: peer.ref };
  });

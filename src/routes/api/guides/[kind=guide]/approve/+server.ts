import { guideError, voiceError } from '#lib/brand.js';
import { brandInput } from '#lib/server/artist/brand.js';
import { approveGuide } from '#lib/server/artist/guides.js';
import { requireArtist } from '#lib/server/artist/profile.js';
import { voiceInput } from '#lib/server/artist/voice.js';
import { ActionError } from '#lib/server/core/errors.js';
import { readBody, respond } from '#lib/server/core/http.js';
import type { RequestHandler } from './$types';

/** Approves the edited proposal named by `proposalId`; a stale or foreign one is a 404. */
export const POST: RequestHandler = ({ locals, params, request }) => {
  const artistId = requireArtist(locals.user);
  return respond(async () => {
    const body = await readBody(request);
    const { proposalId } = body;
    if (typeof proposalId !== 'number')
      throw new ActionError(400, 'Name the proposal being approved.');
    if (params.kind === 'voice') {
      const voice = voiceInput(body);
      const problem = voiceError(voice);
      if (problem) throw new ActionError(422, problem);
      return { approved: await approveGuide(artistId, 'voice', proposalId, voice) };
    }
    const guide = brandInput(body);
    const problem = guideError(guide);
    if (problem) throw new ActionError(422, problem);
    return { approved: await approveGuide(artistId, 'brand', proposalId, guide) };
  });
};

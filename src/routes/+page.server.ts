import { listJobs } from '#lib/server/jobs/jobs.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => ({
  jobs: locals.user ? await listJobs(locals.user.uid) : [],
});

// Stands in for @google-cloud/firestore in the E2E build (vite.config.ts, E2E_FAKES=1): the unit
// tests' in-memory fake, seeded with the fixture jobs when the server starts.
import { Firestore, store } from '../../helpers/fake-firestore';
import { SEED } from './fixtures';

const pad = (n: number) => String(n).padStart(4, '0');

for (const { job, pick, chunks } of SEED) {
  store.set(`jobs/${job.id}`, structuredClone(job));
  if (pick) store.set(`jobs/${job.id}/pick/${pad(pick.version)}`, { ...pick, skipped: false });
  for (const chunk of chunks) store.set(`jobs/${job.id}/chunks/${pad(chunk.index)}`, chunk);
}

export { Firestore };

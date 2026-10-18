// Stands in for $lib/server/core/db in the E2E build (vite.config.ts, E2E_FAKES=1): the unit tests'
// PGlite database, one per server process.
export { db, resetDb } from '../../helpers/db';

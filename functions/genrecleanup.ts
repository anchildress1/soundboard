import { Client } from 'pg';
import { handleGenreCleanup } from '../src/lib/server/core/genre-cleanup';

export default {
  fetch(request: Request): Promise<Response> {
    return handleGenreCleanup(request, () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL is required');
      return new Client({ connectionString, connectionTimeoutMillis: 10_000 });
    });
  },
};

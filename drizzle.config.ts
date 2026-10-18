import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/server/core/schema.ts',
  out: './drizzle',
  // Neon's pooler runs PgBouncer in transaction mode, where migrations can fail; use the direct URL.
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? '' },
});

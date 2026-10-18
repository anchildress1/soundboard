# Agent instructions

Audience: AI coding agents. Directives only.

## Source of truth

- Read `docs/prd.md` before changing behavior.
- Code and PRD disagree → stop, ask.

## Content

- Artist name: "Nathan" or "Flies Like Robots". NEVER write his surname in code, fixtures, seeds, prompts, commits, or docs.
- NEVER filter or redact his surname from runtime data (channel credits, model output).
- UI text: plain labels. NEVER persona or chatbot copy.
- Description voice: `ARTIST_VOICE` in `src/lib/server/ai/smart-pick.ts`. Change only on new evidence of how Nathan writes.
- Audio numbers (LUFS, peak, clipping, silence): ffmpeg only. Strip model-emitted numerics (`src/lib/server/ai/numerics.ts`).
- Hashtags and tags: only from the job's candidate lists (PRD R4). Reject anything else.

## Data and access

- `VERIFIED` only after `videos.list` returns the upload. Insert response → `CLAIMED_COMPLETE`.
- A user is their Google `sub` (`users.uid`). Email is display and invite lookup only.
- Sign-in needs an active invite while `SIGNUP_MODE=invite`. First redemption binds the invite to the `sub`; NEVER rebind it.
- Every job query filters by `ownerUid`. Another user's job → 404, never 403.
- Only a user with `artistId` reads or writes `artist_*` rows or opens `/brand`. Unlinked users' picks run with no artist memory or identity; their feedback stays in `job_feedback`.
- One YouTube connection per user, bound to their own Google account. Refresh tokens: KMS ciphertext in `connections.token_ciphertext` only. NEVER log, trace, or return a token or ciphertext.
- Upload and verify use only the job's approved destination channel and its owner's grant.
- Short approvals write EDITED feedback only, never ACCEPTED.

## Media

- ffmpeg and the YouTube upload read sources from GCS by signed URL.
- NEVER buffer whole media in app memory. Stream in chunks or keep it on disk.
- Short renders: temp file in `os.tmpdir()` → `uploadFile` → delete in `finally` → ffprobe read-back from GCS.
- Sentry: NEVER record audio or image bytes. Use `{type, mime, bytes}` placeholders.

## Architecture

- App: one Cloud Run service, max 1 instance, no GPU.
- Model: one Vertex AI dedicated endpoint, one `g2-standard-4` (one L4), scale to zero, max 1 replica. App → `llama-server` paths via invoke routes, service-account auth.
- NEVER add other services, queues, Cloud Functions, Eventarc, or background workers.
- Pipeline is page-driven: one step per `POST /api/jobs/{id}/step`, each under ~2 minutes.
- Model scaled to zero (429), loading, or busy → return a wait reason immediately. NEVER block a step on it.
- Each step claims the job with one conditional `UPDATE … RETURNING` (claim token, 3-minute expiry). Release only with the matching token.
- Gemma calls: temperature 0.2, `max_tokens` ≥ 2048, JSON schema, parse `content` (not `reasoning_content`). Audio windows: 29.5 s.

## Stack

- SvelteKit 2, Svelte 5 runes, TypeScript strict, Node 24 (`.nvmrc`), pnpm.
- Data: Neon Postgres via Drizzle (`src/lib/server/core/schema.ts`). Schema change → `pnpm drizzle-kit generate`; commit the SQL in `drizzle/`. NEVER hand-edit applied migrations.
- Ask before upgrading to SvelteKit 3, TypeScript 7, or adapter-node 6.

## Tests

- Unit: `tests/unit/`, mirroring `src/`. E2E: `tests/e2e/`.
- Import app code via `$lib` / `$routes`. NEVER relative paths into `src/`.
- Coverage floors: 85% lines/functions/statements, 80% branches. NEVER lower.
- Every new module: positive, negative, error, and edge-case tests.
- Mock at process boundaries only (GCS, KMS, `google-auth-library`, Google/YouTube HTTP via `fetch`, `llama-server`, ffmpeg). NEVER mock internal modules.
- NEVER mock the database. `$lib/server/core/db` aliases to `tests/helpers/db.ts` (PGlite, real migrations) in `vitest.config.ts`; seed rows through it.
- `@sentry/sveltekit` is mocked globally (`tests/mocks/sentry.ts`). Assert through that mock. NEVER load the real SDK in tests.
- E2E projects: desktop Chrome and Pixel 7. Pixel 7 is the primary path.
- E2E builds swap the db module, KMS, and Storage for `tests/e2e/fakes/` (`E2E_FAKES=1`, set by `playwright.config.ts`; wired in `vite.config.ts`). Seed users and jobs in `tests/e2e/fakes/fixtures.ts`; give each test its own job IDs, per Playwright project when the test writes.
- E2E has no `llama-server`: model steps end at the "waking model" wait.

## Workflow

- Run `make ai-checks` before declaring work done.
- Commits: Conventional Commits, signed, one AI attribution footer, `Signed-off-by` (commitlint enforces).
- NEVER commit or push to `main` unless asked.
- GitHub Actions: `actions/*` on tagged majors; all others pinned to a commit SHA with a version comment.

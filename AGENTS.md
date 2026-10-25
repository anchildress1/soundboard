# Agent instructions

Audience: AI coding agents. Directives only.

## Source of truth

- Read `docs/prd.md` before changing behavior.
- Code and PRD disagree → stop, ask.

## Content

- Artist name: "Nathan" or "Flies Like Robots". NEVER write his surname in code, fixtures, seeds, prompts, commits, or docs.
- NEVER filter or redact his surname from runtime data (channel credits, model output).
- UI text: plain labels. NEVER persona or chatbot copy.
- Description voice: the owner's approved voice from `artist_guides`; without one, `GENERIC_VOICE` in `src/lib/server/ai/smart-pick.ts` and no credit line. NEVER put an artist's voice or credit wording in code. Change `GENERIC_VOICE` only on new evidence.
- Artist values come from `artists` only. NEVER add an FLR constant to app code.
- Audio numbers (LUFS, peak, clipping, silence): ffmpeg only (`src/lib/server/ai/numerics.ts`). YouTube numbers: as reported, or computed in `src/lib/server/research/calculated.ts` and labeled calculated. The model NEVER writes a statistic: `src/lib/server/ai/stat-guard.ts` strips them from every stored model-written field.
- Peer influence on a draft: only through the artist's saved sliders (`src/lib/influence.ts`). NEVER copy a peer's sentence, distinctive phrase or channel name (`src/lib/server/ai/copy-check.ts`).
- Hashtags and tags: only from the job's candidate lists (PRD R4), plus the pick's own `artistName` tag exactly once. Reject anything else.

## Data and access

- YouTube API terms: NEVER store a YouTube statistic without its retrieval time. The database hides it after 30 days and deletes it daily. The owner states YouTube accepted the derived-metrics amendment (2026-10-25): brackets and calculated numbers are allowed. NEVER a combined performance score. NEVER aggregate statistics or API data across channels or content owners.
- Peer research, artist outcomes and peer rejections: hidden at 29 days, deleted daily. Long-lived records reference peers only by ref bound to a run (`researchRunId` + `P<n>`), NEVER by name or ID.
- Research writes go through claim-guarded functions in one transaction with the release. NEVER write research results outside the claim.
- YouTube Analytics only with the optional `yt-analytics.readonly` grant. Revocation deletes outcomes (database trigger); a save needs the same live grant.
- Voice and brand proposals keep their source list (video ID, title, date) from the claim until the database hides them at 29 days and the daily job deletes them; disconnect deletes them. Approved guides hold counts, never video IDs or titles.
- `VERIFIED` only after `videos.list` returns the upload. Insert response → `CLAIMED_COMPLETE`.
- A user is their Google `sub` (`users.uid`). Email is the allowlist key and display only.
- `users` is the allowlist: the operator adds emails by hand. Sign-in needs an active row while `SIGNUP_MODE=invite`. First sign-in binds `uid`; NEVER rebind it. `SIGNUP_MODE=open` adds a permanent active row per new account.
- Load a job by a request-supplied ID only through `authorizedJob` (owner check); list jobs only through `listJobs(uid)`. Another user's job → 404, never 403.
- `/brand` and `/api/guides/*` need an artist profile; guides are keyed by the caller's `users.artist_id`. A foreign or stale `proposalId` → 404.
- Gate artist memory and feedback on `artistJob` (job and owner both linked). Otherwise run the pick without them and write feedback to the job's `feedback` array.
- Identity reads need the owner's profile and grant. Without the grant, the pick waits on `reconnect YouTube`.
- NEVER store the pick's identity-read uploads (titles, descriptions, video IDs) in the database.
- One YouTube connection per user, bound to their own Google account. Refresh tokens: KMS ciphertext in `connections.token_ciphertext` only. NEVER log, trace, or return a token or ciphertext.
- GCS upload session URIs: KMS ciphertext in `jobs.data.videoUpload.sessionCipher` only. Requests name a session by `generation`. NEVER log, trace, or put a session URI in a request; return it only from `POST /api/jobs` and `POST /api/jobs/{id}/upload-session`.
- Upload and verify use only the job's approved destination channel and its owner's grant.
- Short approvals write EDITED feedback only, never ACCEPTED.

## Media

- ffmpeg and the YouTube upload read sources from GCS by signed URL.
- Each upload session writes its own object `uploads/<jobId>/<objectId>`; read the video only through `job.object`. NEVER call GCS or KMS inside a database transaction.
- NEVER buffer whole media in app memory. Stream in chunks or keep it on disk.
- Short renders: temp file in `os.tmpdir()` → `uploadFile` → delete in `finally` → ffprobe read-back from GCS.
- Analyst clips: temp file in `os.tmpdir()`, `stat` ≤ 8,000,000 bytes before reading, sent inline, deleted in `finally`. NEVER send the model a URL. Exception: `peer-match` may send a public YouTube watch URL of a peer's upload, clipped to 60 s, only with `PEER_HEARING=1`. NEVER the artist's media.
- Sentry: NEVER record audio, image or video bytes. Use `{type, mime, bytes}` placeholders; video adds `clip: '<start>s–<end>s'`. Keep prompt and reply text for every agent. Replace YouTube-sourced text parts (`source: 'youtube'`, the voice request's uploads included) with their label placeholder (`[YouTube uploads: <n>]`, `[YouTube peers: <n>]`, …). `voice-guide` and `brand-guide`: record reply and reasoning as `[guide proposal: <n> chars]`, including a re-ask's resent reply. `peer-match` and `smart-pick`: keep reply and reasoning text, replacing each value from the prompt's YouTube parts (numbers, titles, channel names, peer text) with `[YouTube data]`, a re-ask's resent reply included.

## Architecture

- App: one Cloud Run service, max 1 instance, no GPU.
- Model: Gemini API, paid tier, through the AI SDK Interactions provider. Only `src/lib/server/ai/model.ts` imports `ai` or `@ai-sdk/google`. One credential: `GEMINI_API_KEY`; NEVER add OAuth headers to model calls.
- NEVER add other services, queues, Cloud Functions, Eventarc, or background workers. Two exceptions (constitution III): research and learning stages, delivered by one Cloud Tasks queue to `POST /api/research/task` (one claimed batch per delivery, same 110 s deadline), and one scheduled database job that deletes expired YouTube data (statistics, proposals, peer research, outcomes, rejections).
- Pipeline is page-driven: one step per `POST /api/jobs/{id}/step`, each under ~2 minutes.
- Research batches are the only work outside a page request. A page load NEVER creates or enqueues a run. A research failure NEVER fails a job.
- Provider 429 or 503 → `model busy`; a per-day quota 429 → `model quota spent` with `limitUntil` set. Return the wait immediately; NEVER retry it inside a step or count it as a failure.
- One 110 s deadline per step, started on claimed-step entry and shared by media work, model calls and the re-ask. NEVER start a fresh one in a helper.
- Each step claims the job with one conditional `UPDATE … RETURNING` (claim token, 3-minute expiry). Release only with the matching token.
- Guide proposals claim (artist, kind) in `guide_claims` with the same token pattern, through `soundboard_claim_proposal`: the database sets the claim time and the connection generation, and `soundboard_save_proposal` refuses a stale claim or a replaced grant.
- SECURITY DEFINER functions: `SET search_path = pg_catalog, public, pg_temp` and `public.`-qualify every relation.
- Model calls: JSON schema via `Output.object`, `store: false`, `maxRetries: 0`, `telemetry: { isEnabled: false }`, no temperature. Per agent: analyst `low` thinking + `mediaResolution: 'low'` + 2048 tokens; smart pick, brand and voice `medium`, hook `low`, each 8192 tokens; `peer-match`: analyst model, `low` thinking, `mediaResolution: 'low'`, 2048 tokens. One re-ask per pick, shared by every check. Windows: 60 s.

## Stack

- SvelteKit 3, Svelte 5 runes, TypeScript strict, Node 24 (`.nvmrc`), pnpm.
- Data: Neon Postgres via Drizzle (`src/lib/server/core/schema.ts`). Schema change → `pnpm drizzle-kit generate`; commit the SQL in `drizzle/`. NEVER hand-edit applied migrations.
- Ask before upgrading to SvelteKit 4, TypeScript 7, or adapter-node 7.

## Tests

- Unit: `tests/unit/`, mirroring `src/`. E2E: `tests/e2e/`.
- Import app code via the `#lib/*` and `#src/*` subpath imports, with the file extension (`.js` for `.ts`). NEVER relative paths into `src/`.
- Coverage floors: 85% lines/functions/statements, 80% branches. NEVER lower.
- Every new module: positive, negative, error, and edge-case tests.
- Mock at process boundaries only (GCS, KMS, `google-auth-library`, Google/YouTube/YouTube Analytics/Gemini/Cloud Tasks HTTP via `fetch`, ffmpeg). NEVER mock internal modules or the AI SDK.
- NEVER mock the database. `#lib/server/core/db` aliases to `tests/helpers/db.ts` (PGlite, real migrations) in `vitest.config.ts`; seed rows through it.
- `@sentry/sveltekit` is mocked globally (`tests/mocks/sentry.ts`). Assert through that mock. NEVER load the real SDK in tests.
- E2E projects: desktop Chrome and Pixel 7. Pixel 7 is the primary path.
- E2E builds swap the db module, KMS, Storage, and window media (`src/lib/server/media/window.ts`) for `tests/e2e/fakes/` (`E2E_FAKES=1`, set by `playwright.config.ts`; wired in `vite.config.ts`). `tests/e2e/fakes/gcs-session.ts` runs as its own Playwright `webServer` on port 4174 and holds every resumable session's offset and landed objects; drive it through its `/control/*` routes. Seed users and jobs in `tests/e2e/fakes/fixtures.ts`; give each test its own job IDs, per Playwright project when the test writes.
- E2E swaps the research queue for `tests/e2e/fakes/tasks.ts`; research results come from fixtures.
- E2E has no live model and no ffmpeg: the `tests/e2e/fakes/gemini.ts` preload answers Gemini HTTP with 429, so model steps end at the "model busy" wait.

## Workflow

- Run `make ai-checks` before declaring work done.
- Commits: Conventional Commits, signed, one AI attribution footer, `Signed-off-by` (commitlint enforces).
- NEVER commit or push to `main` unless asked.
- GitHub Actions: all actions pinned to a commit SHA with a version comment.

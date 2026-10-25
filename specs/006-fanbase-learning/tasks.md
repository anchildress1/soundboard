---
description: 'Task list for learning what grows the fanbase'
---

# Tasks: Learn what grows the fanbase

**Input**: Design documents from `specs/006-fanbase-learning/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/fanbase-learning.md](contracts/fanbase-learning.md), [quickstart.md](quickstart.md)

**Builds on**: `005-artist-branding` at `e7f0356` (and 004 through it). Rebase onto the final 005 before T006 (T002). Every 004 and 005 name used below is checked against their code at that point; a renamed one is followed, not recreated:

- 004: `ownUploads(token, channelId, count, deadline)`, `accessTokenFor(uid, channelId, deadline)`, `identityFailure`, `budgetSignal`, `DeadlineSpent`, `hasModelTime`, `GENERIC_VOICE`, `redactTurns`, `source: 'youtube'`, `artistProfile`, the `reconnect YouTube` and `waiting on YouTube` waits
- 005: `artist_guides`, `approvedGuides`, `guides_update`, `soundboard_save_proposal`, the approve upsert, `handleGenreCleanup`'s `proposals` key, constitution 4.0.0

**Tests**: Required. AGENTS.md and constitution V: positive, negative, error and edge-case tests for every new module.

- Unit tests in `tests/unit/`, mirroring `src/`; E2E in `tests/e2e/`.
- Import app code through `#lib/*` and `#src/*` with `.js` extensions.
- Mock only at process boundaries: YouTube Data, YouTube Analytics, Gemini, Cloud Tasks and Google certificate HTTP via `fetch`; `google-auth-library`; KMS. PGlite with real migrations; Sentry through the global mock. Never the database, internal modules or the AI SDK.
- Each task's tests are part of that task.

**Inventory**: `#n` points at the [plan's inventory](plan.md#inventory). Every entry is closed by a task below.

**Organization**: Setup (governance and gate G1), a Foundational phase that lands the tables, the runner and the pick's wait as one green unit, then one phase per user story. US1–US3 are all P1; US1 is the MVP.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1–US3
- 👤 Yours (or the orchestrator's) to run or approve.

---

## Phase 1: Setup (governance first, then the hearing gate)

**Purpose**: the constitution, PRD and AGENTS.md must allow the design before code changes behavior. Gate G1 proves YouTube URL hearing before any hearing code.

- [ ] T001 Amend `.specify/memory/constitution.md` through `/speckit-constitution` (research R0, inventory #27). Version 4.0.0 → **5.0.0** (MAJOR; the next MAJOR if 005 didn't land 4.0.0), `Last Amended` = commit date, Sync Impact Report updated. First commit of the PR.
  - III, first exception → "Research and learning stages (spec 006) run server-side through one Cloud Tasks queue. Each delivery calls the app service and runs one claimed stage under the step budget. Nothing else uses the queue."
  - III, second exception → "One scheduled database retention job deletes expired YouTube data: statistics, peer research, the artist's analytics outcomes, peer rejections, and proposal inputs."
  - Platform Terms, two new bullets:
    - "YouTube Analytics data is read only through the artist's optional analytics grant. It is refreshed or deleted within 30 days, and deleted when the grant is revoked."
    - "Peer channels and videos are kept at most 30 days. Long-lived records point at them only through expiring evidence, never by name or ID."
  - The owner confirms MAJOR in review.
- [ ] T002 Rebase `006-fanbase-learning` onto the final `005-artist-branding` (itself on 004's final `7256ea4` rulings). Check every name in **Builds on**; record renames in this file's **Builds on** and the PR description. If 005's migration number moved, T046 applies.
- [ ] T003 [P] Update `docs/prd.md` (research R0, inventory #27), each section the spec's Supersedes list names:
  - R4: audience evidence = eligible peer releases plus the genre search (FR-020); peer influence on voice only through saved sliders
  - R5: review adds the Recommendation block, "Why this" sources, the Peers disclosure and **Not a peer**
  - R7: research and learning run as Cloud Tasks deliveries; the rest of the pipeline stays page-driven
  - R9: Connections adds the optional **Share analytics** grant and its deletion on disconnect
  - R11: `peer-match` spans and the labeled YouTube redaction
  - Non-goals: delete "Competitor research beyond the genre search"; keep "No downloading from YouTube" (Gemini fetches, not the app)
  - System design and the Postgres table: `research_runs`, `job_research`, `artist_outcomes`, `peer_rejections`, `artist_guides.influence`; the queue
  - UX: Settings sliders; the working screen's "Researching similar artists"
  - Open Questions: the derived-metrics amendment; OAuth verification lists `yt-analytics.readonly`; plan Q1–Q7
- [ ] T004 [P] Update `AGENTS.md` (research R0, R5, R10, R14, inventory #27). Exact lines:
  - Architecture, replace the exceptions sentence: "Two exceptions (constitution III): research and learning stages, delivered by one Cloud Tasks queue to `POST /api/research/task` (one claimed stage per delivery, same 110 s deadline), and one scheduled database job that deletes expired YouTube data."
  - Architecture, after "Pipeline is page-driven": "Research stages are the only work outside a page request. A page load NEVER creates or enqueues a run."
  - Model calls, append: "`peer-match`: analyst model, `low` thinking, `mediaResolution: 'low'`, 2048 tokens."
  - Media, after the analyst-clips rule: "Exception: `peer-match` may send a public YouTube watch URL of a peer's upload, clipped to 60 s. NEVER the artist's media."
  - Content, add: "Peer influence on a draft: only through the artist's saved sliders (`src/lib/influence.ts`). NEVER copy a peer's sentence, distinctive phrase or channel name (`src/lib/server/ai/copy-check.ts`)."
  - Data and access, add:
    - "Peer research, artist outcomes and peer rejections: hidden at 30 days, deleted daily. Long-lived records reference peers only by ref (`P<n>`), NEVER by name or ID."
    - "NEVER put a YouTube statistic in a prompt."
    - "YouTube Analytics only with the optional `yt-analytics.readonly` grant. Revocation deletes outcomes (database trigger). Report metrics as returned; NEVER compute a net or total."
    - "`BRACKETS_ENABLED` stays unset until YouTube accepts the derived-metrics amendment and the constitution allows grouping."
  - Tests, add: "Mock Cloud Tasks and Google certificate HTTP via `fetch`. E2E swaps the queue for `tests/e2e/fakes/tasks.ts`; research results come from fixtures."
- [ ] T005 👤 Gate G1, run by the orchestrator (research R5, [quickstart G1](quickstart.md#g1--gemini-hears-a-public-youtube-url-gate-before-hearing-code)). Before T012's hearing part and T018. Gemini ≤ $0.05 of this spec's $0.50 share.
  - Write `specs/006-fanbase-learning/gates/g1/g1.mjs`: two `generateText` calls with the Interactions model and the analyst model, `low` thinking, `mediaResolution: 'low'`, 2048 tokens; a file part with a public music-video watch URL, `mediaType: 'video/mp4'`, `providerOptions.google.processing = { type: 'static', startOffset: 0, endOffset: 60 }`; then a private or removed video ID. A `fetch` wrapper logs request hosts only.
  - Run from an isolated directory with the repo's pinned `ai` and `@ai-sdk/google`. Read and append `/private/tmp/claude-501/-Users-anchildress1-git-personal-soundboard/62e697ca-854d-4335-b7d9-d69a103885aa/scratchpad/gemini-ledger.md` before each call.
  - Record `gates/g1/result.json`: the five pass checks (reply describes audio; no `youtube.com` or `googlevideo.com` host from our process; `usage.inputTokens` fits 60 s, not the whole video; the bad URL's status and message; latency). No key, no URL query.
  - **Pass:** `PEER_HEARING=1` goes into `service.yaml` (T044); `minCallMs` = p95 latency rounded up to the next second, used by T012. **Fail:** `PEER_HEARING` stays unset, T012 skips the `youtube` part, T018 is metadata-only. Nothing else changes.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: tables, retention, the queue, the delivery handler and the pick's research wait. Lands green as one unit: the migration, the handler and the pick change together.

- [ ] T006 Schema and migration (data-model, research R2, R8, R10, R11, inventory #1, #2):
  - **`src/lib/server/core/schema.ts`**, exactly as data-model:
    - `researchRuns` (`research_runs`): `job_id text` PK `REFERENCES jobs(id) ON DELETE CASCADE`; `id text not null unique`; `owner_uid text not null REFERENCES users(uid)`; `artist_id text not null REFERENCES artists(id)`; `stage text not null` with `CHECK stage in ('learn','discover','match','releases','done','failed')`; `seq integer not null default 0`; `claim_token text` null; `claim_until timestamptz` null; `consecutive_failures integer not null default 0`; `wait text` null; `error text` null; `limits text[] not null default '{}'`; `cursor integer not null default 0`; `started_at timestamptz not null default now()`; `updated_at timestamptz not null`; `finished_at timestamptz` null. Policy `runs_owner` `FOR ALL TO soundboard_app`: `owner_uid = <principal> and <active>`, both `USING` and `WITH CHECK`.
    - `jobResearch` (`job_research`): `job_id text` PK `REFERENCES jobs(id) ON DELETE CASCADE`; `retrieved_at timestamptz not null`; `evidence jsonb not null`; index on `retrieved_at`. Policies `research_read` (`FOR SELECT TO soundboard_app USING` fresh and the job's `owner_uid = <principal>` and _active_), `research_cleanup_read` and `research_cleanup_delete` (`TO soundboard_cleanup USING` expired).
    - `artistOutcomes` (`artist_outcomes`): PK `(artist_id, video_id)`; `artist_id text not null REFERENCES artists(id)`; `video_id text not null`; `retrieved_at`, `published_at timestamptz not null`; `period_start`, `period_end date not null`; `partial boolean not null`; `metrics jsonb not null`; `live jsonb not null`; `differs_from_approved boolean` null. Policies `outcomes_read` (own artist and fresh), `outcomes_cleanup_read`, `outcomes_cleanup_delete` (expired).
    - `peerRejections` (`peer_rejections`): PK `(artist_id, channel_id)`; `artist_id text not null REFERENCES artists(id)`; `channel_id text not null`; `retrieved_at timestamptz not null`. Policies `rejections_read` (own artist and fresh), cleanup read and delete (expired).
    - `artistGuides.influence jsonb` null with `CHECK (influence is null or (kind = 'brand' and status = 'approved'))` and `CHECK (influence is null or public.soundboard_influence_ok(influence))`.
    - Own-artist predicates compare `u.artist_id = ${t.artistId}`, table-qualified, as `memory_artist` does.
  - **Generate:** `pnpm drizzle-kit generate --name fanbase_learning`.
  - **Before committing,** edit `drizzle/00NN_fanbase_learning.sql`:
    - Put `CREATE FUNCTION public.soundboard_influence_ok(jsonb) RETURNS boolean IMMUTABLE` before the `artist_guides` check: an object with exactly the keys `sound`, `feel`, `wording`, `discovery`, `structure`, each a JSON number that is an integer 0–4.
    - Append `ENABLE` and `FORCE ROW LEVEL SECURITY` on the four new tables.
    - Append grants: `GRANT SELECT, INSERT, DELETE, UPDATE (id, stage, seq, claim_token, claim_until, consecutive_failures, wait, error, limits, cursor, started_at, updated_at, finished_at) ON research_runs TO soundboard_app`; `GRANT SELECT ON job_research, artist_outcomes, peer_rejections TO soundboard_app`; `GRANT SELECT (job_id, retrieved_at), DELETE ON job_research TO soundboard_cleanup`; `GRANT SELECT (artist_id, video_id, retrieved_at), DELETE ON artist_outcomes TO soundboard_cleanup`; `GRANT SELECT (artist_id, channel_id, retrieved_at), DELETE ON peer_rejections TO soundboard_cleanup`. No app write grant on the last three or on `artist_guides.influence`.
    - Append the `SECURITY DEFINER` functions exactly as data-model, each with `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC` and `GRANT EXECUTE … TO soundboard_app`:
      - `soundboard_save_research(p_job text, p_at timestamptz, p_evidence jsonb)`: copied from `soundboard_save_audience` (0004); caller owns the job; refuses `p_at` in the future or already expired; deletes any row for the job (expired included); inserts
      - `soundboard_save_outcomes(p_rows jsonb)`: locks the caller's active `users` row, takes `artist_id` (else `42501`), deletes their rows for the given video IDs (expired included), inserts with `retrieved_at = now()`
      - `soundboard_reject_peer(p_channel text)` and `soundboard_refresh_rejections(p_kept text[], p_gone text[])`: the `users` lock; insert or refresh for the caller's artist; refresh kept, delete gone
      - `soundboard_save_influence(p_influence jsonb) RETURNS integer`: the `users` lock; updates `influence` on the caller's `kind = 'brand' and status = 'approved'` row only; never `body`, `sources`, `proposed_at` or `approved_at`
    - Append `public.soundboard_forget_outcomes()` (`SECURITY DEFINER`) and trigger `connections_forget_outcomes AFTER DELETE OR UPDATE OF status, scopes ON connections FOR EACH ROW`: when the old row was shared (`status = 'connected' and scopes @> '{https://www.googleapis.com/auth/yt-analytics.readonly}'`) and the new row isn't (deleted, not `connected`, or missing the scope), delete `artist_outcomes` for that user's `artist_id`.
  - Never write Nathan's surname.
- [ ] T007 Update `tests/helpers/db.ts`: `truncate()` includes `research_runs`, `job_research`, `artist_outcomes`, `peer_rejections`; `Seed` gains `runs`, `research`, `outcomes` and `rejections` rows (each with an explicit `retrieved_at` so tests can seed expired rows), inserted after `jobs` and `artists`.
- [ ] T008 Migration, RLS and retention-policy tests in `tests/unit/lib/server/core/rls.test.ts` (extend) and new `tests/unit/drizzle/fanbase-learning.test.ts`, under `soundboard_app` unless named:
  - migration replay (new file, 005's harness): applies on top of 005's migration with an approved brand row seeded; that row's `influence` is null and every other column unchanged
  - own rows only on every new table; another user's job, run, research, outcomes and rejections → no rows, writes change 0 rows or are refused
  - expiry boundary per table: `retrieved_at = now() - 30 days + 1 minute` visible; `now() - 30 days` invisible
  - no direct app `INSERT`/`UPDATE` on `job_research`, `artist_outcomes`, `peer_rejections` or `artist_guides.influence`
  - each function: positive; `42501` without identity or profile; replaces an expired row; never touches another artist's rows; `soundboard_save_research` refuses a future and an expired `p_at`; `soundboard_save_influence` returns 0 with no approved brand row and leaves `body`, `sources`, `proposed_at`, `approved_at` unchanged
  - `artist_guides` checks refuse: influence on a proposed row; on a voice row; 4 keys; 6 keys; `5`; `2.5`; `-1`; `"2"`; an array
  - 005's approve upsert on a row with `influence` keeps it
  - trigger: Disconnect (row deleted), `status = 'revoked'`, and a reconnect whose `scopes` lack analytics each delete the artist's outcomes; an update that keeps the scope deletes nothing; another artist's outcomes untouched
  - `soundboard_cleanup`: sees and deletes only expired rows in the three tables; can't read `evidence`, `metrics`, `live`
- [ ] T009 [P] Shared types (data-model, research R11, R12, inventory #18):
  - `src/lib/influence.ts`: `ROLES = ['sound','feel','wording','discovery','structure'] as const`, `Role`, `Influence = Record<Role, 0|1|2|3|4>`, `DEFAULT_INFLUENCE = { sound: 1, feel: 0, wording: 0, discovery: 4, structure: 4 }`, `influenceError(value): string | null` ("Each setting is a whole number from 0 to 4.")
  - `src/lib/types.ts`: `Recommendation = { approach; intendedOutcome; follows: 'artist'|'peers'|'both'|'none'; followsWhy; evidence: string[]; limits: string[] }`; `Wait` gains `'researching similar artists'`; `Pick` gains `influence: Influence`, `citations: Record<Role, string[]>`, `recommendation: Recommendation | null`, `influenceWarning: string | null`, `researchJobId: string | null`, `outcomeRefs: Record<string, string>`
  - `src/lib/status.ts`: the wait's working-screen text "Researching similar artists. You can leave; it keeps going."
  - Tests: `tests/unit/lib/influence.test.ts` (every invalid shape from T008's list; defaults valid), `tests/unit/lib/status.test.ts` (new wait).
- [ ] T010 [P] `src/lib/server/core/env.ts` (inventory #4): `RESEARCH_QUEUE`, `RESEARCH_TASK_URL`, `RESEARCH_TASK_SA` (all optional strings, validated together: all or none), `BRACKETS_ENABLED` and `PEER_HEARING` (`'1'` or unset; anything else is a startup error). Tests in `tests/unit/lib/server/core/env.test.ts`: partial queue config throws; `BRACKETS_ENABLED=true` throws.
- [ ] T011 [P] Retention job (data-model, research R10, inventory #3): `src/lib/server/core/genre-cleanup.ts` runs the three deletes after 005's two, as `soundboard_cleanup`; `functions/genrecleanup.ts` returns `{ deleted, proposals, research, outcomes, rejections }`; any failure → 500. Tests in `tests/unit/lib/server/core/genre-cleanup.test.ts`: expired rows deleted and counted per table, fresh rows kept, a failing delete → 500.
- [ ] T012 [P] Agent `peer-match` and labeled redaction (research R5, R14, inventory #9). Needs T005.
  - `src/lib/server/ai/model.ts`: `AGENTS['peer-match']` = analyst model, `low` thinking, `mediaResolution: 'low'`, 2048 tokens, `minCallMs` from G1. Only when G1 passed: `sdkPart` maps `{ type: 'youtube', url }` to a file part, `mediaType: 'video/mp4'`, `providerOptions.google.processing = { type: 'static', startOffset: 0, endOffset: 60 }`; a URL that isn't `https://www.youtube.com/watch?v=<id>` throws.
  - `src/lib/server/core/tracing.ts`: 004's `source: 'youtube'` redaction gains a `label`; placeholders `[YouTube peers: <n>]`, `[YouTube releases: <n>]`, `[YouTube outcomes: <n>]`; the hearing part → `{ type: 'video', source: 'youtube' }`. Replies kept.
  - Tests in `tests/unit/lib/server/ai/model.test.ts` and `tests/unit/lib/server/core/tracing.test.ts`: request body carries the URL and offsets (Gemini HTTP mocked); a non-watch URL throws; span input holds placeholders, never a title, description or URL; reply text kept.
- [ ] T013 [P] YouTube Data reads (research R4, R6, R8, inventory #6) in `src/lib/server/platforms/youtube/youtube.ts`, exported through `index.ts`:
  - `searchVideos(query, { order: 'relevance', maxResults: 50, categoryId: '10' }, deadline)`; `channelsByIds(ids, deadline)` (`part=snippet,statistics,contentDetails`, `hiddenSubscriberCount` kept); `uploadsOf(playlistId, n, deadline)` (`playlistItems` + `videos.list part=snippet,statistics,contentDetails`)
  - `ownUploads` gains `part=status`; `ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly'`; `analyticsShared(connection)` (`status = 'connected'` and the scope granted). No code outside `platforms/youtube/` names the scope (constitution IV); the migration's trigger is the one SQL copy.
  - Every key read takes the deadline; statistics returned as reported, `null` when absent.
  - Tests in `tests/unit/lib/server/platforms/youtube/youtube.test.ts` (fetch mocked): request params; hidden count → `subscribers: null, hidden: true`; 403 quota → `busy`; deadline spent → `DeadlineSpent`.
- [ ] T014 Queue (research R2, contract, inventory #5, #25):
  - `src/lib/server/research/queue.ts`: `enqueue(delivery, { at? })` → `POST https://cloudtasks.googleapis.com/v2/{RESEARCH_QUEUE}/tasks` with the contract's task JSON, name `<runId>-<seq>`, `dispatchDeadline: '180s'`, an ADC access token from `google-auth-library`. `409 ALREADY_EXISTS` is success. With `RESEARCH_QUEUE` unset and `dev` true, it calls `runDelivery` in-process after the delay (no OIDC). With it unset in a build, it throws.
  - `tests/e2e/fakes/tasks.ts` records enqueues; `vite.config.ts` aliases the queue module under `E2E_FAKES=1` (repo config, listed in the report).
  - Tests in `tests/unit/lib/server/research/queue.test.ts`: request shape and auth header; 409 → ok; 500 → throws; dev path runs the handler; build without queue throws.
- [ ] T015 Run state and delivery handler (research R2, R3, contract, inventory #5, #19, #20):
  - `src/lib/server/research/runs.ts`: `ResearchRun`, `RunStage`, `Delivery`; `startRun(job)` (insert, or replace an expired run: new `id`, `seq` 0, stage `learn`); `claim(delivery)` with one conditional `UPDATE … RETURNING` (`id = $runId and seq = $seq and stage not in ('done','failed') and (claim_until is null or claim_until < now())`); `release(token, outcome)` in one transaction.
  - `src/lib/server/research/delivery.ts`: `runDelivery` steps 1–7 of R2. `deadline = stepDeadline()` at claim entry, passed to every stage. Waits table: busy/`DeadlineSpent` → +60 s; quota → at `until`; grant missing in learn → advance with `youtube-not-connected`; other errors → streak +1, 2 → `failed`. Stage map `{ learn, discover, match, releases }`. Each delivery is one `research.stage` Sentry span tagged `job.id` and stage, never the token or the OIDC JWT (R14). Until T017 and T035 land, `learn` adds `analytics-not-shared` and advances; `discover` ends the run `done` with `no-peers`.
  - `src/routes/api/research/task/+server.ts`: OIDC via `OAuth2Client.verifyIdToken` (`aud = RESEARCH_TASK_URL`, `email = RESEARCH_TASK_SA`, `email_verified`), else 401; body shape else 400; `withIdentity(uid)`. Responses per contract; the body never holds run contents, tokens or errors.
  - `src/hooks.server.ts`: exempt `POST /api/research/task` from the session gate, POST only.
  - Tests in `tests/unit/lib/server/research/{runs,delivery}.test.ts`, `tests/unit/routes/api/research/task/server.test.ts`, `tests/unit/hooks.server.test.ts` (Google certs and Cloud Tasks via fetch): bad or missing token → 401 and nothing read; wrong `aud`/`email` → 401; stale `seq`, other `runId`, finished run, inactive owner → 200, nothing changed; held claim or `seq` ahead → 503; enqueue failure → 500, row unchanged; waits per table; 2 failures → `failed`; the deadline object is the same in every stage call; `GET` on the route isn't exempt.
- [ ] T016 Pick starts and waits for research (research R3, contract "PICK behavior", inventory #13):
  - `src/lib/server/pipeline/pipeline.ts` `pick()`: after 004's grant and profile waits, with no fresh run (none, or `started_at` 30+ days old) → `startRun`, commit, `enqueue(<runId>-0)`, return `{ wait: 'researching similar artists' }`; enqueue failure deletes that run and is a step failure, so the next poll starts a new one. Running and under `RESEARCH_MAX_MS = 10 * 60_000` since `started_at` → the same wait, nothing else runs. `done`, `failed` or past 10 minutes → the pick runs, with `research-unfinished` added when not `done`. Shorts never start a run.
  - Tests in `tests/unit/lib/server/pipeline/pipeline.test.ts`: first call starts one run and one enqueue; enqueue failure → no run row left and the next call starts one; second call while running enqueues nothing; at 10 min the pick proceeds with the limit; `failed` proceeds; expired evidence starts a new run; a Short starts none.

**Checkpoint**: `make ai-checks` green. A pick waits on research, research runs to `done` with `no-peers` and `analytics-not-shared`, and the draft proceeds exactly as before 006 plus those limits.

---

## Phase 3: User Story 1 — Learn from relevant artists without copying them (P1) 🎯 MVP

**Goal**: peers by sound and genre, labeled and explained; per-role sliders; cited sources; influence and copy checks; review shows it all.

**Independent Test**: seeded finished research with 3 peers and distinct writing styles; pick at defaults, then at wording 4: citations follow the role table, wording cites ≥ 2 peers at 4, no 6-word peer run, peers shown unranked with labels.

- [ ] T017 [US1] Evidence I/O and the discover stage (research R4, R6, inventory #5). Q5 before this.
  - `src/lib/server/research/evidence.ts`: `PeerEvidence`, `Peer`, `PeerRelease`, `ChannelStatsReported` exactly as data-model; `saveEvidence(jobId, at, evidence)` through `soundboard_save_research`, where `at` is the row's existing `retrieved_at` after the first write; `readEvidence(jobId)` (fresh only); `resolveRef(ref)` → peer, release, or `{ ref, expired: true, retrievedAt }`.
  - `src/lib/server/research/discover.ts`, replacing T015's placeholder: query = `genreTerms(analysis)` top two + `music`; `searchVideos(order: 'relevance')`; distinct channels in result order, minus the owner's channel and fresh `peer_rejections`; keep 8 (`PEER_CANDIDATES`); `channelsByIds` + newest upload per candidate; `soundboard_refresh_rejections(kept, gone)`; writes the evidence row (candidates) with `retrieved_at` = this stage's first YouTube read; one `execute_tool peer_search` span. Never `order=viewCount`. Tests in `tests/unit/lib/server/research/{evidence,discover}.test.ts`: later saves keep the first `retrieved_at`; expired ref resolves expired; own channel and rejected excluded; 9th dropped; gone rejection deleted; quota → wait; zero results → `done` with `no-peers`.
- [ ] T018 [US1] Match stage (research R5, inventory #5, #10). Needs T005, T012.
  - `src/lib/server/ai/peer-match.ts`: request (song digest, channel title and description, sample title and tags tagged `source: 'youtube'`, plus the `youtube` part when `PEER_HEARING=1`), schema `{ channelKind: 'artist'|'label'|'compilation'|'curator'|'uncertain', sound: 'same'|'different'|'uncertain', explanation }`, validation.
  - `src/lib/server/research/match.ts`: from `cursor`, one call per candidate while `hasModelTime`; keep only `artist` + `same`; basis `heard` when the clip was sent, else `metadata-only`; skipped `{ channelId, reason }`; stop at 5 (`PEER_LIMIT`); `match → match` while candidates remain and fewer than 5 peers; `limits += 'hearing-off'` when hearing is off; `few-peers` under 3.
  - Tests in `tests/unit/lib/server/ai/peer-match.test.ts` and `tests/unit/lib/server/research/match.test.ts` (Gemini via fetch): label, compilation, curator, uncertain skipped; heard vs metadata-only; private sample → metadata-only; 429 → `model busy` wait with cursor kept; redelivery doesn't duplicate peers.
- [ ] T019 [US1] Releases stage (research R6, inventory #5). Q4 before this.
  - `src/lib/server/research/releases.ts`: `uploadsOf(playlist, 10)` per peer; eligible = same `durationBucket` as the upload, published 14 days to 3 years before retrieval, first 3 in upload order (`RELEASES_PER_PEER`); never chosen by statistics; refs `P<n>-R<m>`; then `done`.
  - Tests in `tests/unit/lib/server/research/releases.test.ts`: bucket, 13-day and 3-year-plus-1-day exclusions; a top-viewed old video not picked over a newer eligible one; redelivery replaces the row with the same `retrieved_at`.
- [ ] T020 [P] [US1] Brackets behind `BRACKETS_ENABLED` (research R7, inventory #5), `src/lib/server/research/brackets.ts`: `bracketOf(count | null)` on `[0,100) [100,1k) [1k,10k) [10k,100k) [100k,1M) [1M,∞)`; `relation(artist, peer)` → `same|next|two-up|other`; selection: next first, same fills under 3 next with `same-range-fallback`, two-up labeled secondary, `other` and unknown dropped; a recommendation citing only two-up peers is rejected like an influence mismatch. Flag off: never called, and the limit "Bracket targeting is unavailable until YouTube approves derived metrics." is always added. Tests in `tests/unit/lib/server/research/brackets.test.ts` with the flag on and off: boundaries; hidden count → null; a viral release doesn't move a bracket; flag off → no channel statistic read by selection.
- [ ] T021 [US1] Candidate lists (research R6, inventory #14, #15): `src/lib/server/pipeline/hashtags.ts` `CandidateList` gains `source: 'genre' | 'peer'` and `ref`; each eligible peer release becomes its own list via `rankHashtags`/`rankTags`; never merged, counted or weighted across lists. `src/lib/server/jobs/actions.ts`: approval membership = union of the job's fresh lists; re-run drops a rejected peer's lists. Tests in `tests/unit/lib/server/pipeline/hashtags.test.ts` and `tests/unit/lib/server/jobs/actions.test.ts`: a tag in only a peer list approves; after evidence expiry it's refused; no list carries a count from another.
- [ ] T022 [US1] Saved sliders (research R11, contract, inventory #17, #19). Q2 and Q3 before this.
  - `src/lib/server/artist/guides.ts`: `saveInfluence(influence)` → `soundboard_save_influence`, 0 rows → `409`; `approvedGuides` returns `influence ?? DEFAULT_INFLUENCE`.
  - `src/routes/api/influence/+server.ts` `PUT`: `requireArtist`; invalid → `422` with `influenceError`'s message; no approved brand guide → `409 "Approve your brand guide to save your own settings."`; `200 { influence }`.
  - Tests in `tests/unit/lib/server/artist/guides.test.ts` and `tests/unit/routes/api/influence/server.test.ts`: save and read back; 401/404/409/422; a stored pick's `influence` unchanged after a save. FR-025's "learning never changes defaults" is asserted in T039: a full run leaves the guide row unchanged.
- [ ] T023 [US1] Settings page (contract "/settings", inventory #21): `src/routes/settings/+page.server.ts` loads `{ influence, saved, canSave }`; `src/lib/components/InfluenceSliders.svelte`, one range input 0–4 per role, labeled with the role and its default source, ends "Your own" and "Strongest peer"; Save disabled when `!canSave` with "Approve your brand guide to save your own settings. Drafts use these defaults until then." and a link to Brand. Replace the static peer-influence defaults. Plain labels only. Tests in `tests/unit/routes/settings/page.server.test.ts` and `tests/unit/lib/components/InfluenceSliders.test.ts`.
- [ ] T024 [US1] Smart pick (research R6, R12, R13, inventory #11). Q1 before this.
  - `src/lib/server/ai/smart-pick.ts` context: source refs `analysis`, `voice`, `edits` (labeled preference), `identity`, `P<n>`, `P<n>-R<m>`, `G<n>`; peer releases replace `audienceTopVideos` when peers exist; each YouTube part tagged `source: 'youtube'`; no statistic in the prompt; peers named only by ref.
  - Prompt rules: per-role slider text; peer evidence is reach only; heard peers outrank metadata-only; tactics are tentative, never causes; feedback is preference; conflicts say which evidence is followed (`followsWhy`); sparse evidence says so.
  - Schema adds `citations` (per role) and `recommendation` `{ approach, intendedOutcome, evidence, follows, followsWhy }`.
  - `finalizePick`: drops unknown or role-disallowed refs per R12's table; replaces any peer channel title in recommendation text with its ref; `stripDeep` on the recommendation; tag, hashtag, numeric, length, link and contact rules unchanged.
  - Server-built `limits` (R13): bracket line, `research-unfinished`, `few-peers`, `no-peers`, `hearing-off`, per-role unavailable evidence.
  - Tests in `tests/unit/lib/server/ai/smart-pick.test.ts`: prompt holds refs and no statistic or peer channel ID; disallowed refs dropped; a peer name in the recommendation becomes its ref; a model numeral stripped; same evidence at 0/2/4 yields the expected prompt text per role.
- [ ] T025 [P] [US1] Influence check (research R12), `src/lib/server/ai/influence-check.ts`: level 0 → no peer ref; 1–3 → ≥ 1 peer and ≥ 1 non-peer; 4 → ≥ 1 peer, wording and feel ≥ 2 distinct peers; missing evidence → a limit, not a mismatch. Returns failing roles. Tests in `tests/unit/lib/server/ai/influence-check.test.ts`: every level per role; 2 refs from one peer at 4 fail wording; no peers at 4 → limit only.
- [ ] T026 [P] [US1] Copy check (research R12), `src/lib/server/ai/copy-check.ts`: normalize to lowercase words; a 6+ word run shared with any single peer title, description or channel description is a copy; a peer channel title in a draft field is a copy; runs made only of candidate terms, the song title or the artist name don't count. Tests in `tests/unit/lib/server/ai/copy-check.test.ts`: 5-word run passes, 6 fails; shared genre tags pass; peer name in Bandcamp fails; punctuation and case ignored.
- [ ] T027 [US1] Pick wiring (research R12, R13, inventory #13): `pick()` reads fresh evidence and `approvedGuides().influence`; runs the influence check and the copy check, then **one** re-ask per pick naming the failing roles and copied runs together when `hasModelTime`; afterwards a mismatch → `influenceWarning: 'Influence settings not met'`, a copy → throw, a step failure; stores `influence`, `citations`, `recommendation`, `influenceWarning`, `researchJobId`, `outcomeRefs` on the pick. `brandCheck` unchanged by peer influence. Tests in `tests/unit/lib/server/pipeline/pipeline.test.ts`: mismatch → one re-ask → warning stored, review not blocked; copy → one re-ask → step failure; mismatch and copy together → still one re-ask; a deliberate wording 4 draft gets no voice warning; changing defaults later leaves the stored pick unchanged; no peer name or channel ID in `jobs.picks` or `artist_memory`.
- [ ] T028 [US1] Review (contract "Review data", research R13, inventory #16, #23):
  - `src/lib/server/jobs/view.ts` and `src/routes/jobs/[id]/+page.server.ts`: resolved citations per role; `peers` from fresh evidence or `null`; expired refs as `{ ref, expired: true, retrievedAt }`; `A*` refs through `outcomeRefs` to fresh outcomes with period and `partial`, labeled "Your results (YouTube Analytics)", gained as "on this video's page; a lower bound", expired → "Result no longer stored"; statistics exactly as reported in YouTube's search order, never sorted or totaled; `bracket` and `ranges` only with the flag.
  - `src/lib/components/Recommendation.svelte` (approach, intended outcome, limits, warning), `src/lib/components/Peers.svelte` (name, `heard` or "metadata only", explanation, "Public reach on YouTube" statistics with the retrieval date, **Not a peer**), "Why this" sources on each field in `src/lib/components/Review.svelte`, wired in `src/routes/jobs/[id]/+page.svelte`. "Peer evidence expired on <date>" for expired refs. No form, no new required step.
  - Tests in `tests/unit/lib/server/jobs/view.test.ts`, `tests/unit/routes/jobs/[id]/page.server.test.ts`, `tests/unit/lib/components/{Recommendation,Peers,Review}.test.ts`: order preserved; no total, rank or average field; hidden subscribers shown as hidden; expired ref text; another user's job → 404.
- [ ] T029 [US1] Not a peer (contract, research R13, inventory #19): `src/routes/api/jobs/[id]/peers/[ref]/reject/+server.ts`: `authorizedJob` (404 for another user's), artist job only; a fresh `P*` → `soundboard_reject_peer(channelId)`, `200 { rejected: ref }`; unknown or expired → `409 "That peer's evidence has expired. Reload to see it."`. Tests in `tests/unit/routes/api/jobs/[id]/peers/[ref]/reject/server.test.ts`: positive; 404; 409; a later discover excludes the channel; this job's re-run drops its sources.
- [ ] T030 [US1] E2E (research R16): `tests/e2e/fakes/fixtures.ts` seeds a finished run and evidence with 3 peers (one metadata-only) for per-project job IDs, a fresh and an expired citation, and an artist without an approved brand guide; `tests/e2e/fakes/youtube.ts` serves search and channel reads. New `tests/e2e/research.spec.ts`: the working screen shows the research wait; review shows the Recommendation, peers with labels and statistics, **Not a peer** removes one, an expired citation shows its line. New `tests/e2e/influence.spec.ts`: save sliders with a brand guide; Save disabled without one.

**Checkpoint**: US1 independently testable. Drafts cite sources per role; peers are labeled and unranked.

---

## Phase 4: User Story 2 — Test a recommendation and learn from the result (P1)

**Goal**: optional analytics grant; the learn stage reads the artist's own results; the next pick links adopted recommendations to them.

**Independent Test**: with mocked Analytics, verify a release adopted under recommendation X; run the next pick: its prompt carries `A1` marked adopted with metrics as reported, and the recommendation explains which evidence it follows.

- [ ] T031 [US2] Analytics consent (research R9, contract, inventory #8): `src/lib/server/auth/auth.ts` purpose `analytics` with scopes `SCOPES + ANALYTICS_SCOPE`, `prompt: 'select_account consent'`, `login_hint`; `src/routes/auth/login/+server.ts` `?connect=analytics` needs a session (401 otherwise); `src/routes/auth/callback/+server.ts` reuses `connectGrant(uid, grant, 'connect')` and redirects to `/connections?analytics=shared` or `?analytics=declined`. `YOUTUBE_SCOPES` unchanged; a connected row is never downgraded. Tests in `tests/unit/lib/server/auth/auth.test.ts` and `tests/unit/routes/auth/{login,callback}/server.test.ts`: scope present only for this purpose; declined → declined redirect, row unchanged; no session → 401; nonce and expiry checks as `connect`.
- [ ] T032 [US2] Connections page (contract, inventory #22): `src/routes/connections/+page.server.ts` (through `analyticsShared`) and `+page.svelte`: "Analytics: Shared" or "Analytics: Not shared"; **Share analytics** link when connected and not shared; the note "Stop sharing by disconnecting YouTube; Soundboard deletes your stored results." Tests in `tests/unit/routes/connections/page{,.server}.test.ts`; `tests/e2e/connections.spec.ts` shows the link.
- [ ] T033 👤 [US2] Gate G2 ([quickstart G2](quickstart.md#g2--analytics-with-the-incremental-scope-gate-owner-clicks-consent)). After T031 and T032, before T034. $0 Gemini. Dev OAuth client, a non-Nathan test channel (confirm it isn't Flies Like Robots). The owner clicks consent. Write `specs/006-fanbase-learning/gates/g2/g2.mjs`; record `gates/g2/result.json`: one public upload's response, a no-data video, and the error for a grant without the scope. No token, no channel name. If shapes differ from R8, update R8 and T034 before code.
- [ ] T034 [US2] Analytics client (research R8, inventory #7), `src/lib/server/platforms/youtube/analytics.ts`: `videoReport(token, videoId, start, end, deadline)` → `GET https://youtubeanalytics.googleapis.com/v2/reports` with `ids=channel==MINE`, `metrics=views,subscribersGained,subscribersLost`, `dimensions=video`, `filters=video==<id>`; no rows → all null; `analyticsFailure` maps G2's missing-scope error to `analytics-not-shared`, 429/503 to `busy`; one `execute_tool analytics_report` span, never the token. Exported through `index.ts`. Tests in `tests/unit/lib/server/platforms/youtube/analytics.test.ts` with G2's recorded shapes.
- [ ] T035 [US2] Learn stage (research R8, R10, inventory #5), `src/lib/server/research/learn.ts`, replacing T015's placeholder: not shared → `analytics-not-shared`, no call; else `accessTokenFor`, `ownUploads(token, channelId, 20, deadline)` with status; private and unlisted skipped with `private-releases`; per public upload one `videoReport` over publish date to +27 days capped at today, `partial` when open; `soundboard_save_outcomes`; live title, description (≤ 700) and tags compared with the publish record's `finalFields` → `differs_from_approved`. Metrics stored as returned; no net. Tests in `tests/unit/lib/server/research/learn.test.ts`: pre-Soundboard uploads included; private skipped; revised report replaces (one row); partial window; Studio edit flagged; refused grant → `youtube-not-connected` and advance; no consent → no Analytics request.
- [ ] T036 [US2] Outcomes in the pick (research R12, FR-007, FR-008). Q6 before this. `src/lib/server/ai/smart-pick.ts` adds `A<n>` per fresh outcome with `adopted` (a matching publish record's recommendation), `partial`, `editedAfterApproval`, metrics as reported, gained labeled "a lower bound"; prompt rules: repeated comparable artist outcomes outrank loose peer observations; a repeat is a pattern to try again, never proof. Tests in `tests/unit/lib/server/ai/smart-pick.test.ts`: adopted outcome present with no manual entry (SC-004); missing metrics stay null, never 0; no subtraction or sum in the prompt.
- [ ] T037 [US2] Adoption (research R8, inventory #13, #17): `recordVerified` in `src/lib/server/pipeline/pipeline.ts` writes `recommendation: { approach, intendedOutcome, evidence }` and `influence` to the publish record (`src/lib/server/artist/memory.ts` shape); a Short's record has `recommendation: null`. Refs only, no YouTube data. Tests in `tests/unit/lib/server/pipeline/pipeline.test.ts` and `tests/unit/lib/server/artist/memory.test.ts`.
- [ ] T038 [US2] Revocation end to end (research R10): `tests/unit/routes/api/connections/youtube/disconnect/server.test.ts` and `tests/unit/lib/server/platforms/youtube/connection.test.ts`: Disconnect, `markRevoked` and a reconnect without the scope each leave the artist's `artist_outcomes` empty; the platform code imports nothing from `artist/` or `research/`.

**Checkpoint**: US2 independently testable with mocked Analytics.

---

## Phase 5: User Story 3 — Run without paid research or extra administration (P1)

**Goal**: research survives a closed browser, retries don't duplicate, page loads never start it, free-source failures never block a draft.

**Independent Test**: start a pick, stop polling, drive deliveries from the queue fake to `done`, then poll again: the draft runs on saved evidence, row counts unchanged by redelivery.

- [ ] T039 [US3] Continuity and idempotency (FR-003, SC-006) in `tests/unit/lib/server/research/delivery.test.ts`: with no step calls after the first, the four stages complete from deliveries alone; each delivery redelivered twice leaves `job_research`, `artist_outcomes` and `peer_rejections` counts unchanged; a crash after enqueue and before release re-runs the stage once with the same results; a full run leaves the artist's `artist_guides` rows unchanged (FR-025).
- [ ] T040 [US3] No research on page loads (US3 AS4): `tests/unit/routes/isolation.test.ts` (extend) calls every `+page.server.ts` and `+layout.server.ts` load as a signed-in artist with a job at `PICK`: zero `research_runs` inserts and zero Cloud Tasks requests.
- [ ] T041 [US3] Free-source failure (FR-011, SC-001) in `tests/unit/lib/server/pipeline/pipeline.test.ts`: YouTube quota through every stage and a `failed` run each end in a draft with its limits; every mocked request host is Google's. SC-001's "no paid dependency" is T045's `package.json` check.
- [ ] T042 [US3] No added actions (FR-014, SC-007): `tests/e2e/pipeline.spec.ts` (extend) runs a seeded release from upload to approve with the same required clicks as before 006; the Recommendation and Peers blocks need no input.

**Checkpoint**: all three stories independently testable.

---

## Phase 6: Polish and validation

- [ ] T043 [P] Docs (inventory #24, #28):
  - `docs/operations/youtube-retention.md`: the three new tables, their 30-day hide and daily delete, the response keys, the revocation trigger
  - new `docs/operations/research-runner.md`: the queue, its config, IAM, `anchildress1-unstable` target, the OIDC check, how to read a stuck run, why nothing runs without work
  - `docs/youtube-audit/architecture.md` and `user-flows.md`: peer research (Non-Authorized, 30 days), Analytics (optional grant, 30 days, deleted on revoke), no aggregation, statistics never in prompts
  - `src/routes/privacy/+page.svelte`: analytics sharing, peer research, 30-day deletion, disconnect deletes results; update its test if it asserts text
- [ ] T044 [P] Config (inventory #26; repo config, list each in the report):
  - `service.yaml`: env `RESEARCH_QUEUE`, `RESEARCH_TASK_URL`, `RESEARCH_TASK_SA`; `BRACKETS_ENABLED` absent; `PEER_HEARING` per T005
  - `deploy.sh`: enable `cloudtasks.googleapis.com` and `youtubeanalytics.googleapis.com`; create or update `soundboard-research` with `--max-concurrent-dispatches 1 --max-attempts 20 --min-backoff 10s --max-backoff 300s --max-retry-duration 3600s`; IAM per R2; honors `GCP_PROJECT_ID`. Never run.
  - `.env.example` and the `README.md` env table: the five keys, with dev leaving the queue unset
- [ ] T045 Sweep, output recorded in the PR description:
  - `grep -rnE "order: ?'viewCount'|viewCount" src/lib/server/research` → nothing
  - `grep -rnE "\.reduce\(|sum\(|avg\(|count\(" src/lib/server/research src/lib/server/jobs/view.ts` → no hit over statistics
  - no `channelId` or peer title in `jobs.picks` or `artist_memory` writes (T027's test passes)
  - `git --no-pager diff 005-artist-branding -- package.json pnpm-lock.yaml` adds no dependency (SC-001)
  - no surname anywhere in the diff
- [ ] T046 After the T002 rebase, if 005's migration number moved: delete this migration, its snapshot and journal entry, rerun `pnpm drizzle-kit generate --name fanbase_learning`, paste T006's appended SQL back, and rerun T008 and T047.
- [ ] T047 Validation loop (max 5 attempts, then stop with the exact errors):
  1. `make ai-checks`: coverage ≥ 85/85/85/80, zero warnings
  2. `pnpm exec playwright test`: both projects
  3. `semgrep scan --config auto --error --metrics=off` on changed files: zero findings
  4. SonarQube `analyze_code_snippet` on each changed or added source file: zero issues
  5. `pnpm audit --prod` and `pnpm audit`: zero
- [ ] T048 👤 Live local validation ([quickstart](quickstart.md) Q0–Q6). Gemini ≤ **$0.50 total for this spec**, G1 included.
  - Read `/private/tmp/claude-501/-Users-anchildress1-git-personal-soundboard/62e697ca-854d-4335-b7d9-d69a103885aa/scratchpad/gemini-ledger.md` before each call; log agent, model, tokens and cost.
  - Dev `.env` and dev Neon branch only; `RESEARCH_QUEUE` unset (in-process deliveries).
  - A non-Nathan test user and channel; confirm on `/connections` it isn't Flies Like Robots, else stop and report. No upload.
  - One ≤ 60 s video from `$HOME/Downloads/*.mp4`, read only.
  - Record each Q step pass or fail; a spent share leaves the rest **unverified**, named.
- [ ] T049 👤 Operator, after deploy (never run by agents; deployment freeze): quickstart "After deploy": `GCP_PROJECT_ID=anchildress1-unstable ./deploy.sh`, `genrecleanup` redeploy, a closed-browser run with 200s in Cloud Tasks logs, a forged POST → 401.
- [ ] T050 👤 Owner, not a merge gate: apply for the derived-metrics amendment; add `yt-analytics.readonly` to the OAuth client's Data Access; list it in the verification and YouTube audit submissions (`docs/youtube-audit/`, updated by T043).

---

## Requirement coverage

| Req    | Tasks                                          |
| ------ | ---------------------------------------------- |
| FR-001 | T024, T028, T035, T036                         |
| FR-002 | T031, T032, T033, T035, T016                   |
| FR-003 | T014, T015, T016, T039, T040                   |
| FR-004 | T035                                           |
| FR-005 | T019, T024                                     |
| FR-006 | T024, T027, T028                               |
| FR-007 | T035, T036, T037                               |
| FR-008 | T024, T036                                     |
| FR-009 | T024                                           |
| FR-010 | T020, T028, T035, T036, T045                   |
| FR-011 | T016, T041                                     |
| FR-012 | T006, T008, T011, T028, T038                   |
| FR-013 | MAY; not used (research R13)                   |
| FR-014 | T028, T042                                     |
| FR-015 | T006, T008, T011, T009, T028, T035, T038, T045 |
| FR-016 | T017, T020, T024, T028                         |
| FR-017 | T020                                           |
| FR-018 | T018, T020, T028                               |
| FR-019 | T020, T028                                     |
| FR-020 | T019, T021, T024                               |
| FR-021 | T009, T022, T023                               |
| FR-022 | T025, T026, T027                               |
| FR-023 | T022, T027                                     |
| FR-024 | T025, T027                                     |
| FR-025 | T022, T024, T027, T039                         |
| SC-001 | T041, T045                                     |
| SC-002 | T024, T025, T027, T048                         |
| SC-003 | T017, T018, T020, T028                         |
| SC-004 | T036, T037                                     |
| SC-005 | T024, T036, T048                               |
| SC-006 | T015, T039                                     |
| SC-007 | T042                                           |
| SC-008 | T008, T011, T045                               |

## Dependencies and execution order

- **Setup (T001–T005):** T001 first commit; T003, T004 [P] after it. T002 before T006. T005 before T012's hearing part and T018.
- **Foundational (T006–T016)** blocks every story and lands green together: T006 → T007 → T008; T009, T010, T011, T013 [P] beside T006; T012 after T005; T014 after T010; T015 after T006, T014; T016 after T015.
- **US1 (T017–T030):** T017 (needs T013) → T018 → T019; T020 [P]; T021 after T019; T022 → T023; T024 after T019, T021, T022; T025, T026 [P] beside T024; T027 after T024–T026; T028 after T027; T029 after T017, T028; T030 last.
- **US2 (T031–T038):** T031 → T032 → T033 → T034 → T035; T036 after T024 and T035; T037 after T027; T038 after T006.
- **US3 (T039–T042):** after T016; T040 anytime; T041 after T027; T042 after T028.
- **Polish:** T043, T044 [P] after Foundational; T045 after every story; T046 at the rebase; T047 after T045; T048 after T047; T049 at the first deploy; T050 anytime.

## Parallel examples

- **Foundational:** T009 (`src/lib/influence.ts`), T010 (`env.ts`), T011 (`genre-cleanup.ts`), T013 (`youtube.ts`) beside T006.
- **US1:** T020 (`brackets.ts`), T025 (`influence-check.ts`), T026 (`copy-check.ts`) beside T024.
- **Polish:** T043 docs beside T044 config.

## Implementation strategy

- **MVP:** Phases 1–3. Peers by sound and genre, sliders, citations and checks, review display, with outcomes unknown (`analytics-not-shared`).
- **Then** US2's learning and US3's continuity tests.
- **One PR** on `006-fanbase-learning`, stacked on `005-artist-branding`. Commits per task group, signed and atomic; T001 first.

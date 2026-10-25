---
description: 'Task list for learning what grows the fanbase'
---

# Tasks: Learn what grows the fanbase

**Input**: Design documents from `specs/006-fanbase-learning/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/fanbase-learning.md](contracts/fanbase-learning.md), [quickstart.md](quickstart.md)

**Builds on**: `005-artist-branding` at `8eaedae` (on 004 at `7256ea4`). Every 004 and 005 name used below is checked against their merged code (T002); a renamed one is followed, not recreated:

- 004: `ownUploads(token, channelId, count, deadline)`, `accessTokenFor(uid, channelId, deadline)`, `identityFailure`, `budgetSignal`, `DeadlineSpent`, `hasModelTime`, `GENERIC_VOICE`, `redactTurns`, `source: 'youtube'`, `artistProfile`, the `reconnect YouTube` and `waiting on YouTube` waits
- 005: `artist_guides`, `approvedGuides`, `guides_update`, the approve upsert, `AGENTS[agent].redactReply`, `handleGenreCleanup`'s `proposals` key, constitution 4.0.0

**Renames found by T002** (005 at `7e2dc0a`):

- `AGENTS[agent].redactReply` shipped as `GUIDE_AGENTS` and `guidePlaceholder` in `src/lib/server/core/tracing.ts`; a re-ask's resent guide reply is tagged `source: 'guide'`. 006 follows that shape.
- SECURITY DEFINER functions use `SET search_path = pg_catalog, public, pg_temp` and `public.`-qualify every relation (005 final pass); 006's functions do the same.
- 005's migration is `0006_artist_guides`; 006's is `0007_fanbase_learning`.

**Owner rulings after the plan (binding, 2026-10-25):**

- Sentry keeps `peer-match` and `smart-pick` reply and reasoning text. Only the API-derived values (numbers, peer titles, channel names, peer text drawn from the prompt's YouTube parts) become `[YouTube data]`. This replaces the whole-reply placeholder in T001, T004, T012 and R14.

**Tests**: Required. AGENTS.md and constitution V: positive, negative, error and edge-case tests for every new module.

- Unit tests in `tests/unit/`, mirroring `src/`; E2E in `tests/e2e/`.
- Import app code through `#lib/*` and `#src/*` with `.js` extensions.
- Mock only at process boundaries: YouTube Data, YouTube Analytics, Gemini, Cloud Tasks and Google certificate HTTP via `fetch`; `google-auth-library`; KMS. PGlite with real migrations; Sentry through the global mock. Never the database, internal modules or the AI SDK.
- Each task's tests are part of that task.

**Inventory**: `#n` points at the [plan's inventory](plan.md#inventory). Every entry is closed by a task below.

**Organization**: Setup (governance, gate G1), a Foundational phase that lands tables, pure helpers, the runner and the pick's research wait as one green unit, then one phase per user story. US1–US3 are all P1; US1 is the MVP.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1–US3
- 👤 Yours (or the orchestrator's) to run or approve.

---

## Phase 1: Setup (governance first, then the hearing gate)

**Purpose**: the constitution, PRD and AGENTS.md must allow the design before code changes behavior. Gate G1 proves YouTube URL hearing before hearing code.

- [x] T001 Amend `.specify/memory/constitution.md` through `/speckit-constitution` (research R0, inventory #27). Version 4.0.0 → **5.0.0** (MAJOR), `Last Amended` = commit date, Sync Impact Report updated. First commit of the PR.
  - III, first exception → "Research and learning stages (spec 006) run server-side through one Cloud Tasks queue. Each delivery calls the app service and runs one claimed stage under the step budget. Nothing else uses the queue."
  - III, second exception → "One scheduled database retention job deletes expired YouTube data: statistics, peer research, the artist's analytics outcomes, peer rejections, and proposal inputs."
  - Platform Terms, replace "Until YouTube accepts the derived-metrics amendment, no number MAY be calculated from YouTube statistics, and no channel MAY be scored, ranked or grouped by its statistics." with "The owner states that YouTube accepted the derived-metrics amendment (III.L, recorded 2026-10-25). Numbers calculated from YouTube statistics MUST be computed in code from stored data and labeled as calculated; reported numbers are shown exactly as YouTube returns them. Model output MUST NOT contain statistics. No combined performance score."
  - Platform Terms, add: "YouTube Analytics data is read only through the artist's optional analytics grant. It is refreshed or deleted within 30 days, and deleted when the grant is revoked." and "Peer channels and videos are kept at most 30 days. Long-lived records point at them only through expiring evidence, never by name or ID."
  - Media, Privacy and Secrets, extend the Sentry bullet: "… or the reply or reasoning of an agent that can restate YouTube API data (peer match, smart pick, guide proposals)."
  - Keep unchanged: the 30-day storage bullet and "API data MUST NOT be aggregated across different content owners."
  - 👤 Owner confirms MAJOR in review.
- [x] T002 Before T006, check every name in **Builds on** against 005's and 004's merged code in `src/`; record renames in this file's **Builds on** and the PR description. If 005's migration number moved, T048 applies.
- [x] T003 [P] Update `docs/prd.md` (research R0, inventory #27):
  - R4: audience evidence = comparable peer releases plus the genre search (FR-020); peer influence on voice only through saved sliders; peer and artist statistics may enter the pick prompt; the model writes no statistic; calculated numbers are labeled. The genre search's own rules ("view counts never enter candidate logic", top videos) stay for genre lists.
  - R5: review adds the Recommendation block (with current and target ranges), "Why this" sources, the Peers disclosure, the artist's results, and **Not a peer**
  - R7: research and learning run as Cloud Tasks deliveries; a research failure never fails the release; Discard also ends research
  - R9: the optional **Share analytics** grant and its deletion on disconnect
  - R11: `peer-match`; `peer-match` and `smart-pick` replies and reasoning recorded as placeholders
  - Non-goals: delete "Competitor research beyond the genre search"; keep "No downloading from YouTube"
  - System design and the Postgres table: the four tables, `artist_guides.influence`, the queue, the `anchildress1-unstable` environment
  - UX: Settings sliders; the working screen's "Researching similar artists"
  - Open Questions: the derived-metrics acceptance record (plan O1); OAuth verification lists `yt-analytics.readonly`
- [x] T004 [P] Update `AGENTS.md` (research R0, R5, R7, R10, R14, inventory #27). Exact lines:
  - Architecture, replace the exceptions sentence: "Two exceptions (constitution III): research and learning stages, delivered by one Cloud Tasks queue to `POST /api/research/task` (one claimed batch per delivery, same 110 s deadline), and one scheduled database job that deletes expired YouTube data."
  - Architecture, after "Pipeline is page-driven": "Research batches are the only work outside a page request. A page load NEVER creates or enqueues a run. A research failure NEVER fails a job."
  - Model calls, append: "`peer-match`: analyst model, `low` thinking, `mediaResolution: 'low'`, 2048 tokens. One re-ask per pick, shared by every check."
  - Media, after the analyst-clips rule: "Exception: `peer-match` may send a public YouTube watch URL of a peer's upload, clipped to 60 s. NEVER the artist's media."
  - Content, add: "Peer influence on a draft: only through the artist's saved sliders (`src/lib/influence.ts`). NEVER copy a peer's sentence, distinctive phrase or channel name (`src/lib/server/ai/copy-check.ts`)."
  - Content, replace the audio-numbers line: "Audio numbers: ffmpeg only (`numerics.ts`). YouTube numbers: as reported, or computed in `src/lib/server/research/calculated.ts` and labeled calculated. The model NEVER writes a statistic (`stat-guard.ts`)."
  - Data and access, replace the "NEVER calculate numbers from YouTube statistics … until YouTube accepts the derived-metrics amendment" sentence: "The owner states YouTube accepted the derived-metrics amendment (2026-10-25): brackets and calculated numbers are allowed. NEVER a combined performance score. NEVER aggregate statistics across channels."
  - Data and access, add:
    - "Peer research, artist outcomes and peer rejections: hidden at 29 days, deleted daily. Long-lived records reference peers only by ref bound to a run (`researchRunId` + `P<n>`), NEVER by name or ID."
    - "Research writes go through claim-guarded functions in one transaction with the release. NEVER write research results outside the claim."
    - "YouTube Analytics only with the optional `yt-analytics.readonly` grant. Revocation deletes outcomes (database trigger); a save needs the same live grant."
  - Sentry line, add: "`peer-match` and `smart-pick`: record reply and reasoning as placeholders, including a re-ask's resent reply."
  - Tests, add: "Mock Cloud Tasks and Google certificate HTTP via `fetch`. E2E swaps the queue for `tests/e2e/fakes/tasks.ts`; research results come from fixtures."
- [ ] T005 👤 Gate G1, run by the orchestrator (research R5, [quickstart G1](quickstart.md#g1--gemini-hears-a-public-youtube-url-gate-before-hearing-code)). Before T012's hearing part and T020. Gemini ≤ $0.05 of the $0.50 share.
  - Write `specs/006-fanbase-learning/gates/g1/g1.mjs`: two `generateText` calls with the Interactions model and the analyst model, `low` thinking, `mediaResolution: 'low'`, 2048 tokens; a file part with a public music-video watch URL, `mediaType: 'video/mp4'`, `providerOptions.google.processing = { type: 'static', startOffset: 0, endOffset: 60 }`; then a private or removed video ID. A `fetch` wrapper logs request hosts only.
  - Run from an isolated directory with the repo's pinned `ai` and `@ai-sdk/google`. Read and append `/private/tmp/claude-501/-Users-anchildress1-git-personal-soundboard/62e697ca-854d-4335-b7d9-d69a103885aa/scratchpad/gemini-ledger.md` before each call.
  - Record `gates/g1/result.json`: the five pass checks. No key, no URL query.
  - **Pass:** `PEER_HEARING=1` goes into `service.yaml` (T046); `minCallMs` = p95 latency rounded up to the next second, used by T012. **Fail:** `PEER_HEARING` stays unset, T012 skips the `youtube` part, T020 is metadata-only.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: tables, pure helpers, retention, the queue, the delivery handler and the pick's research wait. Lands green as one unit.

- [ ] T006 Schema and migration (data-model, research R2, R8, R10, R11, inventory #1, #2):
  - **`src/lib/server/core/schema.ts`**, exactly as data-model:
    - `researchRuns` (`research_runs`): `job_id text` PK `REFERENCES jobs(id) ON DELETE CASCADE`; `id text not null unique`; `owner_uid text not null REFERENCES users(uid)`; `artist_id text not null REFERENCES artists(id)`; `stage text not null` with `CHECK stage in ('learn','discover','match','releases','done','failed')`; `seq integer not null default 0`; `cursor integer not null default 0`; `claim_token text` null; `claim_until timestamptz` null; `consecutive_failures integer not null default 0`; `wait`, `error text` null; `limits text[] not null default '{}'`; `started_at timestamptz not null default now()`; `updated_at timestamptz not null`; `finished_at timestamptz` null. Policy `runs_owner` `FOR ALL TO soundboard_app`: `USING owner_uid = <principal> and <active>`; `WITH CHECK` the data-model's job-owned and caller's-artist predicate.
    - `jobResearch` (`job_research`): `run_id text` PK (no FK); `job_id text not null REFERENCES jobs(id) ON DELETE CASCADE`; `retrieved_at timestamptz not null`; `evidence jsonb not null`; indexes on `retrieved_at` and `job_id`. Policies `research_read` (fresh, job owned by the principal, active), `research_cleanup_read`, `research_cleanup_delete` (expired).
    - `artistOutcomes` (`artist_outcomes`): PK `(artist_id, video_id)`; `artist_id text not null REFERENCES artists(id)`; `video_id text not null`; `retrieved_at`, `published_at timestamptz not null`; `requested_start`, `requested_end date not null`; `coverage text not null` with `CHECK coverage in ('open','complete','unknown')`; `metrics`, `live jsonb not null`; `differs_from_approved boolean` null. Policies `outcomes_read` (own artist, fresh, shared now), cleanup read and delete (expired).
    - `peerRejections` (`peer_rejections`): PK `(artist_id, channel_id)`; `retrieved_at timestamptz not null`. Policies `rejections_read` (own artist, fresh), cleanup read and delete.
    - _Fresh_ is `retrieved_at > now() - interval '29 days'` on all three.
    - `artistGuides.influence jsonb` null with `CHECK (influence is null or (kind = 'brand' and status = 'approved'))` and `CHECK (influence is null or public.soundboard_influence_ok(influence))`.
    - Own-artist predicates compare `u.artist_id = ${t.artistId}`, table-qualified.
  - **Generate:** `pnpm drizzle-kit generate --name fanbase_learning`.
  - **Before committing,** edit `drizzle/00NN_fanbase_learning.sql`:
    - Put `public.soundboard_influence_ok(jsonb) RETURNS boolean IMMUTABLE` before the check.
    - Append `ENABLE` and `FORCE ROW LEVEL SECURITY` on the four new tables.
    - Append grants: `GRANT SELECT, INSERT, DELETE, UPDATE (id, stage, seq, cursor, claim_token, claim_until, consecutive_failures, wait, error, limits, started_at, updated_at, finished_at) ON research_runs TO soundboard_app`; `GRANT SELECT ON job_research, artist_outcomes, peer_rejections TO soundboard_app`; `GRANT SELECT (run_id, retrieved_at), DELETE ON job_research TO soundboard_cleanup`; `GRANT SELECT (artist_id, video_id, retrieved_at), DELETE ON artist_outcomes TO soundboard_cleanup`; `GRANT SELECT (artist_id, channel_id, retrieved_at), DELETE ON peer_rejections TO soundboard_cleanup`. No app write grant on the last three or on `artist_guides.influence`.
    - Append the functions exactly as data-model (`SECURITY DEFINER`, `SET search_path = pg_catalog, public`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO soundboard_app`):
      - `soundboard_save_research(p_run, p_token, p_at, p_evidence)`: _claim held_; refuses future or expired `p_at`; upsert by `run_id`, `retrieved_at = coalesce(existing, p_at)`
      - `soundboard_save_outcomes(p_run, p_token, p_grant_at, p_rows)`: _claim held_; the `connections` row `FOR SHARE` with `status = 'connected'`, the scope, `updated_at = p_grant_at`, else `28000`; then delete and insert for the caller's artist
      - `soundboard_reject_peer(p_channel)`; `soundboard_refresh_rejections(p_run, p_token, p_kept, p_gone)` (_claim held_)
      - `soundboard_save_influence(p_influence) RETURNS integer`: approved brand row only; never `body`, `sources`, `proposed_at`, `approved_at`
    - Append `public.soundboard_forget_outcomes()` and trigger `connections_forget_outcomes AFTER DELETE OR UPDATE OF status, scopes, updated_at ON connections FOR EACH ROW`: old row shared and new row not → delete the user's artist's `artist_outcomes`.
  - Never write Nathan's surname.
- [ ] T007 Update `tests/helpers/db.ts`: `truncate()` includes the four tables; `Seed` gains `runs`, `research`, `outcomes`, `rejections` rows, each with an explicit `retrieved_at` (or `started_at`), inserted after `jobs` and `artists`.
- [ ] T008 Migration, RLS and retention-policy tests in `tests/unit/lib/server/core/rls.test.ts` (extend) and new `tests/unit/drizzle/fanbase-learning.test.ts`, under `soundboard_app` unless named:
  - migration replay (005's harness): applies on top of 005's migration with an approved brand row seeded; that row's `influence` is null and every other column unchanged
  - own rows only on every new table; another user's rows → none visible, writes change 0 rows or are refused
  - forged runs (#6): an insert with the caller's `owner_uid` and another user's `job_id`, and one with an `artist_id` that isn't the caller's, are both refused
  - expiry boundary per table: `retrieved_at = now() - 29 days + 1 minute` visible; `now() - 29 days` invisible
  - outcomes need current sharing: visible while shared, invisible after the scope is gone even before the trigger's delete is checked
  - claim-guarded functions: positive with the run's live token; `55000` with a wrong token, an expired claim, another user's run, or a discarded job, and nothing written; `soundboard_save_research` refuses future and expired `p_at` and keeps the first `retrieved_at` on a second save
  - `soundboard_save_outcomes`: `28000` when the connection is revoked, missing the scope, or has a different `updated_at`; nothing written
  - `soundboard_save_influence`: returns 0 with no approved brand row; leaves the other columns unchanged
  - `artist_guides` checks refuse: influence on a proposed row; on a voice row; 4 keys; 6 keys; `5`; `2.5`; `-1`; `"2"`; an array
  - 005's approve upsert on a row with `influence` keeps it
  - trigger: Disconnect (row deleted), `status = 'revoked'`, and a reconnect whose scopes lack analytics each delete the artist's outcomes; a reconnect keeping the scope deletes nothing; another artist's outcomes untouched
  - `soundboard_cleanup`: sees and deletes only expired rows; can't read `evidence`, `metrics`, `live`
- [ ] T009 [P] Shared types (data-model, research R11, R12, inventory #18):
  - `src/lib/influence.ts`: `ROLES`, `Role`, `Influence`, `DEFAULT_INFLUENCE = { sound: 1, feel: 0, wording: 0, discovery: 4, structure: 4 }`, `influenceError(value)` ("Each setting is a whole number from 0 to 4.")
  - `src/lib/types.ts`: `Recommendation`; `Calculated = { value: number | null; calculated: true }`; `Wait` gains `'researching similar artists'`; `Pick` gains `influence`, `citations`, `recommendation`, `influenceWarning`, `researchRunId`, `evidenceExpiresAt`, `outcomeRefs`
  - `src/lib/status.ts`: "Researching similar artists. You can leave; it keeps going."
  - Tests: `tests/unit/lib/influence.test.ts` (each invalid shape from T008's list; defaults valid), `tests/unit/lib/status.test.ts`.
- [ ] T010 [P] `src/lib/server/core/env.ts` (inventory #4): `RESEARCH_QUEUE`, `RESEARCH_TASK_URL`, `RESEARCH_TASK_SA` (all or none), `PEER_HEARING` (`'1'` or unset). Tests in `tests/unit/lib/server/core/env.test.ts`: partial queue config throws; `PEER_HEARING=true` throws.
- [ ] T011 [P] Retention job (data-model, research R10, inventory #3): `src/lib/server/core/genre-cleanup.ts` runs the three 29-day deletes after 005's two, as `soundboard_cleanup`; `functions/genrecleanup.ts` returns `{ deleted, proposals, research, outcomes, rejections }`; any failure → 500. Tests in `tests/unit/lib/server/core/genre-cleanup.test.ts`: expired deleted and counted per table, fresh kept, a failing delete → 500.
- [ ] T012 Agent `peer-match` and redaction (research R5, R14, inventory #9). Needs T005.
  - `src/lib/server/ai/model.ts`: `AGENTS['peer-match']` = analyst model, `low` thinking, `mediaResolution: 'low'`, 2048 tokens, `minCallMs` from G1, `redactReply: 'peer match'`; `AGENTS['smart-pick'].redactReply = 'pick'`. Only when G1 passed: `sdkPart` maps `{ type: 'youtube', url }` to a file part with the 60 s static processing; a URL that isn't `https://www.youtube.com/watch?v=<id>` throws.
  - `src/lib/server/core/tracing.ts`: `source: 'youtube'` parts gain a `label` (`[YouTube peers: <n>]`, `[YouTube releases: <n>]`, `[YouTube outcomes: <n>]`; the hearing part `{ type: 'video', source: 'youtube' }`); `redactReply` agents' `chat` reply and reasoning and `agentOutput` → `[<label>: <n> chars]`; a resent reply tagged `source: 'reply'` → the same placeholder.
  - Tests in `tests/unit/lib/server/ai/model.test.ts` and `tests/unit/lib/server/core/tracing.test.ts`: the request carries the URL and offsets; a non-watch URL throws; a sentinel outcome metric (`987654`) and a peer title in the request, echoed by the mocked Gemini reply and reasoning, appear in no span attribute, including the re-ask's; the hook's reply is still recorded.
- [ ] T013 Shared re-ask allowance (research R12, #16, inventory #9, #11): `chatJson` in `src/lib/server/ai/model.ts` and `runPick` in `src/lib/server/ai/smart-pick.ts` take one `asks = { left: 1 }` per pick; the parse re-ask, the repeat re-ask and T029's checks each spend it. Tests in `tests/unit/lib/server/ai/{model,smart-pick}.test.ts`: malformed reply then a repeat → 2 provider calls, then a step failure; malformed then valid → 2 calls; the deadline object is the same across calls.
- [ ] T014 [P] YouTube reads (research R4, R6, R8, R9, inventory #6) in `src/lib/server/platforms/youtube/{youtube,connection,index}.ts`:
  - `searchVideos(query, { order: 'relevance', maxResults: 50, categoryId: '10' }, deadline)`; `channelsByIds(ids, deadline)` (`part=snippet,statistics,contentDetails`, `hiddenSubscriberCount` kept); `uploadsOf(playlistId, n, deadline)`
  - `ownUploads` gains `part=status`; `accessTokenFor` also returns `grantAt` (the connection's `updated_at`)
  - `ANALYTICS_SCOPE`; `analyticsShared(connection)`. No code outside `platforms/youtube/` names the scope; the migration's trigger is the one SQL copy.
  - Statistics returned as reported, `null` when absent.
  - Tests in `tests/unit/lib/server/platforms/youtube/{youtube,connection}.test.ts` (fetch mocked): params; hidden count → `subscribers: null, hidden: true`; quota → `busy`; deadline spent → `DeadlineSpent`; `grantAt` matches the row.
- [ ] T015 [P] Pure helpers (research R7, inventory #5, #12):
  - `src/lib/server/research/calculated.ts`: `netSubscribers`, `engagementRate`, each `Calculated`; null input or zero views → `null`
  - `src/lib/server/research/brackets.ts`: `bracketOf` on `[0,100) [100,1k) [1k,10k) [10k,100k) [100k,1M) [1M,∞)`; `relation` → `same|next|two-up|other`; `selectPeers(kept)`: next first up to 5; under 3 next → same fills to 3 with `same-range-fallback`; up to 2 two-up as `secondary` within 5; `soleSecondary(evidence, peers)`
  - `src/lib/server/ai/stat-guard.ts`: `stripStats(text) → { text, removed }` per R7's rules; an emptied field → "Not stated."
  - Tests in `tests/unit/lib/server/research/{calculated,brackets}.test.ts` and `tests/unit/lib/server/ai/stat-guard.test.ts`: boundaries 99/100/999/1000; hidden → null; a viral release can't move a bracket (count unchanged); `other` dropped; 2 next + 4 same → 3 peers with fallback; stat-guard removes "1200 views", "net is 12 subscribers", "Views rose 20%", "twelve thousand views", "doubled its subscribers", "2x the plays"; keeps "the last 3 releases", "60-second intro", "Track 2"; `numerics.ts` behavior unchanged.
- [ ] T016 Queue (research R2, contract, inventory #5, #25):
  - `src/lib/server/research/queue.ts`: `enqueue(delivery, at, deadline)` → `POST https://cloudtasks.googleapis.com/v2/{RESEARCH_QUEUE}/tasks` with the contract's task JSON; ADC token and request under `budgetSignal(deadline)` (#10); `409` is success. Dev with `RESEARCH_QUEUE` unset → in-process `runDelivery` after the delay; a build without it throws.
  - `tests/e2e/fakes/tasks.ts` records enqueues; `vite.config.ts` aliases the queue module under `E2E_FAKES=1` (repo config, listed in the report).
  - Tests in `tests/unit/lib/server/research/queue.test.ts`: shape and auth header; 409 → ok; 500 → throws; a stalled token fetch and a stalled request each end at the deadline as `DeadlineSpent`; dev path; build throws.
- [ ] T017 Run state and delivery handler (research R2, R3, contract, inventory #5, #19, #20):
  - `src/lib/server/research/runs.ts`: `startRun(job)` (insert, or replace a failed or expired run: new `id`, `seq` 0, stage `learn`); `claim(delivery)` with the R2 conditional `UPDATE … RETURNING` (all four delivery fields, not discarded); `commit(token, batch)` in one transaction: the claim-guarded writes, then the release with the same token.
  - `src/lib/server/research/delivery.ts`: `runDelivery` steps 1–7 of R2; `deadline = stepDeadline()` at claim entry, passed to every stage and to `enqueue`; stages stop taking items when less than `RESERVE_MS = 8_000` plus the item estimate remains; batch results stay in memory until the commit; enqueue failure → release with nothing written, `500`; the waits table; zero progress → streak +1. One `research.stage` span per delivery (`job.id`, stage, cursor), never a token or JWT. Until T019 and T037 land, `learn` adds `analytics-not-shared` and advances, and `discover` ends `done` with `no-peers`.
  - `src/routes/api/research/task/+server.ts`: OIDC via `OAuth2Client.verifyIdToken` (`aud`, `email`, `email_verified`), else 401; body shape else 400; `withIdentity(uid)`.
  - `src/hooks.server.ts`: exempt `POST /api/research/task`, POST only.
  - Tests in `tests/unit/lib/server/research/{runs,delivery}.test.ts`, `tests/unit/routes/api/research/task/server.test.ts`, `tests/unit/hooks.server.test.ts`: bad, missing or wrong-audience token → 401, nothing read; a delivery whose `uid` or `jobId` doesn't match the row → 200 stale, nothing changed; lower `seq`, finished run, discarded job → 200; held claim or `seq` ahead → 503; enqueue failure → 500, `job_research` contents unchanged; a stale worker whose claim expired and was retaken commits nothing, and the other worker's evidence is byte-for-byte unchanged (#5); waits per table; 2 failures → `failed`; the deadline object is the same in every call; `GET` isn't exempt.
- [ ] T018 Pick and research (research R3, contract "PICK behavior", inventory #13, #15):
  - `src/lib/server/pipeline/pipeline.ts` `pick()`: after 004's waits; no fresh run (none, `failed`, or `started_at` 29+ days old) → `startRun`, commit, `enqueue(<runId>-0, now, deadline)`, return the wait. Enqueue failure or an ambiguous acknowledgement → mark the run `failed` (`research-unavailable`) and run the pick now, without peers and with that limit. Never a step failure (#8). Running and under `RESEARCH_MAX_MS = 10 * 60_000` → the wait. `done`, `failed` or past 10 minutes → the pick, with `research-unfinished` when not `done`. Shorts never start a run.
  - `src/lib/server/jobs/actions.ts` discard: marks the job's run `failed` (`discarded`) and clears its claim in the discard transaction (#19).
  - Tests in `tests/unit/lib/server/pipeline/pipeline.test.ts` and `tests/unit/lib/server/jobs/actions.test.ts`: first call starts one run and one enqueue; two consecutive enqueue failures each produce a draft with `research-unavailable` and leave the job's failure streak at 0; an enqueue that times out after the task was created → the later delivery is stale; second call while running enqueues nothing; at 10 min the pick proceeds; a Short starts none; discard during a batch → that batch commits nothing, the queued delivery is stale, another job's run is untouched.

- [ ] T054 Must-fix (Codex r2 #2): a `failed` run is terminal during ordinary polling: the pick proceeds without peers and never restarts it. Only an explicit re-run (`rerun`, in the skip transaction) deletes a failed run, so the next PICK step starts a new one. Tests: repeated polls after a worker failure each proceed to the pick and enqueue nothing; a re-run after a failure starts exactly one new run.
- [ ] T055 Must-fix (Codex r2 #3): an enqueue that fails or spends the step budget persists the run as `failed` (`research-unavailable`); when too little model time remains, the step returns its wait and the next claimed step generates. Tests: a stalled enqueue ends at the shared deadline without restarting it, marks the run failed, returns `model busy`, and the next step generates without starting research.
- [ ] T056 Must-fix (Codex r2 #4): the genre search failing on YouTube quota (`quotaExceeded`, `dailyLimitExceeded`) is not a step failure: the pick generates with empty genre evidence, stores none, and adds the limit `genre-search-unavailable`. Tests: a first pick with no cached candidates, research and genre search both on quota, produces a draft with both limits and only the artist tag.
- [ ] T057 Must-fix (Codex r2 #5): recognized waits (`ModelBusy`, `ModelQuotaSpent`, YouTube busy, `DeadlineSpent`) take precedence over zero-progress counting; only a batch that completed nothing without a wait counts toward the streak. Tests: consecutive zero-progress 429 and 503 deliveries leave the streak unchanged.

**Checkpoint**: `make ai-checks` green. A pick waits on research, research runs to `done` with `no-peers` and `analytics-not-shared`, and the draft proceeds as before 006 plus those limits.

---

## Phase 3: User Story 1 — Learn from relevant artists without copying them (P1) 🎯 MVP

**Goal**: peers by sound, genre and bracket, labeled and explained; per-role sliders; cited sources; influence, copy and stat checks; review shows it all.

**Independent Test**: seeded research with 3 peers (next, same, two-up) and distinct writing styles; pick at defaults, then at wording 4: citations follow the role table, wording cites ≥ 2 peers at 4, no copied phrase, no model-written statistic, peers shown with ranges, labels and calculated engagement.

- [ ] T019 [US1] Evidence I/O and discover (research R4, R6, R7, inventory #5). Q5 decided (plan).
  - `src/lib/server/research/evidence.ts`: `PeerEvidence`, `Peer`, `PeerRelease`, `ChannelStatsReported`, `Bracket` exactly as data-model; `saveEvidence(run, token, at, evidence)` through `soundboard_save_research`; `readEvidence(runId)` (fresh only); `resolveRef(pick, ref)` → peer, release, or `{ ref, expired: true, expiresAt: pick.evidenceExpiresAt }`.
  - `src/lib/server/research/discover.ts`, replacing T017's placeholder. Batch 1: query = `genreTerms(analysis)` top two + `music`; `searchVideos(order: 'relevance')`; distinct channels minus own and fresh rejections; one `channelsByIds` for them plus the artist's channel; `relation` per channel, `other` and unknown into `skipped` (any unknown → `peer-range-unknown`); order next, same, two-up, each in search order; keep 12 (`PEER_CANDIDATES`); the artist's count hidden → search order and `artist-range-unknown`; refresh rejections. Batches 2+: each candidate's newest upload from `cursor`. One `execute_tool peer_search` span. Never `order=viewCount`.
  - Tests in `tests/unit/lib/server/research/{evidence,discover}.test.ts`: a second save keeps the first `retrieved_at`; an old pick's `P1` resolves against its own run after a newer run for the same job saved a different `P1` (#7); cleanup of the old row → expired with the stored date; own channel and rejected excluded; a channel 3 ranges up is skipped before the cap; a hidden-count channel is skipped with `peer-range-unknown`; 12 kept in priority order; gone rejection deleted; quota → wait with progress kept; a stage longer than one deadline finishes over several deliveries (#9).
- [ ] T020 [US1] Match (research R5, R7, inventory #5, #10). Needs T005, T012.
  - `src/lib/server/ai/peer-match.ts`: request (song digest, channel and sample text tagged `source: 'youtube'`, the `youtube` part when `PEER_HEARING=1`), schema `{ channelKind, sound, explanation }`, validation.
  - `src/lib/server/research/match.ts`: from `cursor`, one call per candidate while time allows; keep `artist` + `same`; basis `heard` or `metadata-only`; stop at 5 next-range peers or the end; then `selectPeers`; limits `hearing-off`, `few-peers` (under 3), `no-peers`.
  - Tests in `tests/unit/lib/server/ai/peer-match.test.ts` and `tests/unit/lib/server/research/match.test.ts`: label, compilation, curator and uncertain skipped; heard vs metadata-only; a private sample → metadata-only; 429 → `model busy` with cursor kept; redelivery doesn't duplicate peers; 5 next kept before any same is matched.
- [ ] T021 [US1] Releases (research R6, inventory #5). Q4 decided (plan). `src/lib/server/research/releases.ts`: per peer from `cursor`, `uploadsOf(playlist, 10)`; `comparableLength(release, upload)` (both > 0; same side of 180 s; within max(60 s, 25 %)); published 14 days to 3 years before retrieval; within that peer only, pick `newest`, then `most-viewed`, then `most-engaged` (`engagementRate`) among the rest, nulls can't win, ties to the newer; refs `P<n>-R<m>`; then `done`. Tests in `tests/unit/lib/server/research/releases.test.ts`: 180 vs 181 s not comparable; 1141 s vs a 19-minute upload comparable; unknown length excluded; 13-day and 3-year-plus-1-day excluded; the three slots on a fixture; a null-views release can't be `most-viewed`; nothing compares releases across peers.
- [ ] T022 [US1] Candidate lists and the approval pool (research R6, R13, #11, inventory #14, #15): `src/lib/server/pipeline/hashtags.ts` `CandidateList` gains `source: 'genre' | 'peer'` and `ref`; each peer release becomes its own list; never merged, counted or weighted across lists. `src/lib/server/jobs/actions.ts` (`tagError`, `finalFields`) and `jobs.ts` (`hashtagCandidates`): allowed = fresh genre lists ∪ fresh peer lists of `pick.researchRunId`; when either pool has expired, the stored draft's own selected tags and hashtags stay allowed; re-run drops a rejected peer's lists. Tests in `tests/unit/lib/server/pipeline/hashtags.test.ts` and `tests/unit/lib/server/jobs/actions.test.ts`: a peer-only tag approves while fresh; after the peer pool expires, the draft's own peer-only tag still approves and a new peer-only tag is refused; same with only the genre pool expired.
- [ ] T023 [US1] Shorts (research R13, #12, inventory #15): `createShort` in `src/lib/server/jobs/jobs.ts` keeps the copied pick's `researchRunId` and `evidenceExpiresAt`, sets `recommendation: null` and `outcomeRefs: {}`. Tests in `tests/unit/lib/server/jobs/jobs.test.ts` and `tests/unit/lib/server/pipeline/short.test.ts`: the Short approves the parent's peer-only tag while fresh and falls back to its own selected terms after the original expiry; its recommendation is null.
- [ ] T024 [US1] Saved sliders (research R11, contract, inventory #17, #19). Q2, Q3 decided (plan). `src/lib/server/artist/guides.ts`: `saveInfluence` (0 rows → 409); `approvedGuides` returns `influence ?? DEFAULT_INFLUENCE`. `src/routes/api/influence/+server.ts` `PUT` per contract. Tests in `tests/unit/lib/server/artist/guides.test.ts` and `tests/unit/routes/api/influence/server.test.ts`: save and read back; 401/404/409/422; a stored pick's `influence` unchanged after a save.
- [ ] T025 [US1] Settings page (contract "/settings", inventory #21): `src/routes/settings/+page.server.ts` loads `{ influence, saved, canSave }`; `src/lib/components/InfluenceSliders.svelte` per contract; Save disabled without a brand guide, with the line and a Brand link; replaces the static peer-influence defaults. Tests in `tests/unit/routes/settings/page.server.test.ts` and `tests/unit/lib/components/InfluenceSliders.test.ts`.
- [ ] T026 [US1] Smart pick (research R6, R7, R12, R13, inventory #11). Q1 decided (plan).
  - `src/lib/server/ai/smart-pick.ts` context: refs `analysis`, `voice`, `edits` (preference), `identity`, `P<n>` (bracket, relation, `secondary`), `P<n>-R<m>` (`selectedAs`), `G<n>`; reported statistics and calculated values, labeled, in `source: 'youtube'` parts; peer releases replace `audienceTopVideos` when peers exist; peers named only by ref.
  - Prompt rules per R12, including "never write a number about views, subscribers or engagement".
  - Schema adds `citations` and `recommendation`.
  - `finalizePick`: drops unknown or role-disallowed refs; replaces any peer channel title in recommendation text with its ref; runs `stripStats` on `approach`, `intendedOutcome`, `followsWhy`; tag, hashtag, audio-numeric, length, link and contact rules unchanged.
  - Server-built `limits` (R13).
  - Tests in `tests/unit/lib/server/ai/smart-pick.test.ts`: the prompt holds refs, labeled statistics and calculated values, no peer channel ID; disallowed refs dropped; a peer name in the recommendation becomes its ref; "Views rose 20%" in `followsWhy` is removed and stored text has none; same evidence at 0/2/4 yields the expected per-role prompt text.
- [ ] T027 [P] [US1] Influence check (research R12), `src/lib/server/ai/influence-check.ts`: level rules per R12; missing evidence → a limit, not a mismatch; returns failing roles. Tests in `tests/unit/lib/server/ai/influence-check.test.ts`: every level per role; 2 refs from one peer at 4 fail wording; no peers at 4 → limit only.
- [ ] T028 [P] [US1] Copy check (research R12, #17), `src/lib/server/ai/copy-check.ts`: the four rules and the exemption exactly as R12. Tests in `tests/unit/lib/server/ai/copy-check.test.ts`: a 6-word run fails, 5 doesn't by rule 1; a 4-word peer sentence ("Born in the static.") copied whole fails; a 3-word phrase with a word absent from the artist's text, analysis and candidates fails; the same 3 words all present in the artist's own text pass; a run of whole candidate terms ("dark synthwave", "retro") passes; a 6-word peer sentence whose words each appear inside candidate terms but not as whole terms fails (exemption abuse); a peer name in Bandcamp fails; case and punctuation ignored.
- [ ] T029 [US1] Pick wiring (research R7, R12, R13, inventory #13): `pick()` reads `readEvidence(run.id)`, fresh outcomes and `approvedGuides().influence`; after the reply runs the influence check, copy check and `soleSecondary`; failures share T013's allowance (one re-ask naming every failure); after it's spent: mismatch → `influenceWarning`, copy → throw (step failure), sole secondary → `recommendation: null` with `secondary-only`. Stores `influence`, `citations`, `recommendation`, `influenceWarning`, `researchRunId`, `evidenceExpiresAt`, `outcomeRefs`. `brandCheck` unchanged by peer influence. Tests in `tests/unit/lib/server/pipeline/pipeline.test.ts`: mismatch → one re-ask → warning, review not blocked; copy and mismatch together → still one re-ask, total 2 provider calls; parse failure then copy → 2 calls then step failure; sole two-up evidence → re-ask → recommendation null with the limit; deliberate wording 4 → no voice warning; later default changes leave the stored pick; no peer name or channel ID in `jobs.picks` or `artist_memory`.
- [ ] T058 [US1] Must-fix (Codex r2 #1): `stripStats` runs on every persisted model-written field in `finalizePick` (title, description, `why`, `brandCheck`, Bandcamp about and credits, the recommendation), so feedback rows and publish records built from the pick carry none either. Tests: a sentinel statistic (`987654 views`) in every field of a mocked reply appears in no stored pick, feedback row or publish record.
- [ ] T059 [US1] Owner ruling (Sentry): `peer-match` and `smart-pick` spans keep reply and reasoning text with the prompt's YouTube values replaced by `[YouTube data]` (`agentOutput` and the re-ask's resent reply too). Tests: a sentinel metric and a peer title echoed in the mocked reply and reasoning appear in no span attribute while the rest of the reply text does.
- [ ] T030 [US1] Review (contract "Review data", research R13, inventory #16, #23): `src/lib/server/jobs/view.ts` and `src/routes/jobs/[id]/+page.server.ts` build the contract's review data (citations, `ranges`, peers of the pick's run, expired refs with `evidenceExpiresAt`, `A*` refs). `src/lib/components/Recommendation.svelte`, `src/lib/components/Peers.svelte`, "Why this" in `src/lib/components/Review.svelte`, wired in `src/routes/jobs/[id]/+page.svelte`. Labels exactly as the contract. No form, no new required step. Tests in `tests/unit/lib/server/jobs/view.test.ts`, `tests/unit/routes/jobs/[id]/page.server.test.ts`, `tests/unit/lib/components/{Recommendation,Peers,Review}.test.ts`: selection order kept; no field totals across peers; engagement and net labeled "calculated"; hidden subscribers shown hidden; expired citation text with its date; another user's job → 404.
- [ ] T031 [US1] Not a peer (contract, research R13, inventory #19): `src/routes/api/jobs/[id]/peers/[ref]/reject/+server.ts` per contract. Tests in `tests/unit/routes/api/jobs/[id]/peers/[ref]/reject/server.test.ts`: positive; 404; 409; a later discover excludes the channel; this job's re-run drops its sources.
- [ ] T032 [US1] E2E (research R16): `tests/e2e/fakes/fixtures.ts` seeds a finished run and evidence with 3 peers (next, same, two-up; one metadata-only) for per-project job IDs, a fresh and an expired citation, outcomes, and an artist without an approved brand guide; `tests/e2e/fakes/youtube.ts` serves search and channel reads. New `tests/e2e/research.spec.ts`: the research wait; the Recommendation with ranges; peers with labels, statistics and calculated engagement; the artist's results; **Not a peer** removes one; an expired citation's line. New `tests/e2e/influence.spec.ts`: save sliders with a brand guide; Save disabled without one.

**Checkpoint**: US1 independently testable.

---

## Phase 4: User Story 2 — Test a recommendation and learn from the result (P1)

**Goal**: optional analytics grant; the learn stage reads the artist's own results safely; the next pick links what was suggested and what was published to them.

**Independent Test**: with mocked Analytics, verify a release adopted under recommendation X, then rewrite its description in "Studio" (mocked read-back); run the next pick: its prompt carries `A1` with the suggestion, the published fields, the live change flag, reported metrics, coverage and calculated net; the recommendation explains which evidence it follows.

- [ ] T033 [US2] Analytics consent (research R9, contract, inventory #8): `src/lib/server/auth/auth.ts` purpose `analytics` (`SCOPES + ANALYTICS_SCOPE`, `prompt: 'select_account consent'`, `login_hint`); `src/routes/auth/login/+server.ts` `?connect=analytics` needs a session; `src/routes/auth/callback/+server.ts` reuses `connectGrant(uid, grant, 'connect')` and redirects to `?analytics=shared` or `?analytics=declined`. `YOUTUBE_SCOPES` unchanged. Tests in `tests/unit/lib/server/auth/auth.test.ts` and `tests/unit/routes/auth/{login,callback}/server.test.ts`: the scope only for this purpose; declined → row unchanged; no session → 401; nonce and expiry checks.
- [ ] T034 [US2] Connections page (contract, inventory #22): `src/routes/connections/+page.server.ts` (through `analyticsShared`) and `+page.svelte`: the status line, **Share analytics**, the note. Tests in `tests/unit/routes/connections/page{,.server}.test.ts`; `tests/e2e/connections.spec.ts` shows the link.
- [ ] T035 👤 [US2] Gate G2 ([quickstart G2](quickstart.md#g2--analytics-with-the-incremental-scope-gate-owner-clicks-consent)). After T033 and T034, before T036. $0 Gemini, dev OAuth client, a non-Nathan test channel (confirm it isn't Flies Like Robots); the owner clicks consent. Write `specs/006-fanbase-learning/gates/g2/g2.mjs`; record `gates/g2/result.json` per quickstart, including the coverage call for a recent upload (#14). No token, no channel name. Shapes that differ from R8 update R8 and T036 before code.
- [ ] T036 [US2] Analytics client (research R8, #14, inventory #7), `src/lib/server/platforms/youtube/analytics.ts`: `videoReport(token, videoId, start, end, deadline)` (totals); `coverageDay(token, videoId, day, deadline)` (`dimensions=day`, one day) → `boolean`; `pacificDate(instant)`; `analyticsFailure` (missing scope → `analytics-not-shared`, 429/503 → `busy`); one `execute_tool analytics_report` span per call, never the token. Exported through `index.ts`. Tests in `tests/unit/lib/server/platforms/youtube/analytics.test.ts` with G2's shapes: no rows → nulls; `pacificDate('2026-10-25T06:59:00Z')` = `2026-10-24`; `pacificDate('2026-03-08T10:30:00Z')` = `2026-03-08` (after the DST change); `2026-11-01T08:30:00Z` = `2026-11-01`.
- [ ] T037 [US2] Learn stage (research R8, R10, inventory #5), `src/lib/server/research/learn.ts`, replacing T017's placeholder: not shared → `analytics-not-shared`; else `accessTokenFor` (with `grantAt`), `ownUploads(…, 20, deadline)`; private and unlisted skipped (`private-releases`); per public upload from `cursor`, `videoReport` over the Pacific window plus `coverageDay(requested_end)` → `coverage`; live title, description and tags compared with the publish record's `fields` on full whitespace-normalized values, then the description clipped to 700; batch committed through `soundboard_save_outcomes(run, token, grantAt, rows)`; `28000` → the batch is dropped and the next delivery re-reads the grant (a wait, not a failure). Tests in `tests/unit/lib/server/research/learn.test.ts`: pre-Soundboard uploads included; private skipped; revised report replaces (one row); `open` window; delayed data → `unknown`; complete → `complete`; an unchanged 900-character description → `differs_from_approved = false`; a changed one → true; a refused grant → `youtube-not-connected` and advance; no consent → no Analytics request; 20 uploads that don't fit one deadline finish over several deliveries; a disconnect committed while a report is in flight → the save writes nothing; a reconnect mid-flight → the old grant's save writes nothing (#4).
- [ ] T038 [US2] Outcomes in the pick (research R8, R12, FR-007, FR-008, #13): `src/lib/server/ai/smart-pick.ts` adds `A<n>` per fresh outcome with the suggestion (if adopted), the approved `fields` as published, live metadata (tagged), `editedBeforeApproval`, `differsFromApproved`, coverage, reported metrics and calculated net; gained labeled "a lower bound"; the prompt separates "suggested" from "published". Tests in `tests/unit/lib/server/ai/smart-pick.test.ts`: an adopted outcome appears with no manual entry (SC-004); a completely rewritten draft shows `editedBeforeApproval` and the published fields, not the suggestion's; missing metrics stay null, never 0; `coverage: 'unknown'` is labeled.
- [ ] T039 [US2] Adoption (research R8, inventory #13, #17): `recordVerified` in `src/lib/server/pipeline/pipeline.ts` writes `recommendation`, `influence` and `editedBeforeApproval` to the publish record (`src/lib/server/artist/memory.ts` shape); a Short's has `recommendation: null`. Tests in `tests/unit/lib/server/pipeline/pipeline.test.ts` and `tests/unit/lib/server/artist/memory.test.ts`.
- [ ] T040 [US2] Revocation end to end (research R10): `tests/unit/routes/api/connections/youtube/disconnect/server.test.ts` and `tests/unit/lib/server/platforms/youtube/connection.test.ts`: Disconnect, `markRevoked` and a reconnect without the scope each leave `artist_outcomes` empty and review's `A*` refs "Result no longer stored"; the platform code imports nothing from `artist/` or `research/`.

**Checkpoint**: US2 independently testable with mocked Analytics.

---

## Phase 5: User Story 3 — Run without paid research or extra administration (P1)

**Goal**: research survives a closed browser, retries don't duplicate, page loads never start it, failures never block a draft.

**Independent Test**: start a pick, stop polling, drive deliveries from the queue fake to `done`, then poll: the draft runs on saved evidence; redelivery leaves contents unchanged.

- [ ] T041 [US3] Continuity and idempotency (FR-003, SC-006) in `tests/unit/lib/server/research/delivery.test.ts`: with no step calls after the first, every stage completes from deliveries alone; each delivery redelivered twice leaves `job_research`, `artist_outcomes` and `peer_rejections` contents unchanged; a crash after enqueue and before commit re-runs that batch once; a full run leaves the artist's `artist_guides` rows unchanged (FR-025).
- [ ] T042 [US3] No research on page loads (US3 AS4): `tests/unit/routes/isolation.test.ts` (extend) calls every `+page.server.ts` and `+layout.server.ts` load as a signed-in artist with a job at `PICK`: zero `research_runs` inserts and zero Cloud Tasks requests.
- [ ] T043 [US3] Free-source failure (FR-011, SC-001) in `tests/unit/lib/server/pipeline/pipeline.test.ts`: YouTube quota through every stage, a `failed` run, and a queue that's down each end in a draft with its limits; the job's failure streak stays 0; every mocked request host is Google's.
- [ ] T044 [US3] No added actions (FR-014, SC-007): `tests/e2e/pipeline.spec.ts` (extend) runs a seeded release from upload to approve with the same required clicks as before 006; the new blocks need no input.

**Checkpoint**: all three stories independently testable.

---

## Phase 6: Polish and validation

- [ ] T045 [P] Docs (inventory #24, #28):
  - `docs/operations/youtube-retention.md`: the three new tables, the 29-day hide and daily delete, the response keys, the revocation trigger and the grant check on save
  - new `docs/operations/research-runner.md`: the queue, config, IAM, the OIDC check, how to read a stuck run, why nothing runs without work, and the one-time `anchildress1-unstable` setup (project, service account, KMS, bucket, secrets on the unstable Neon branch, OAuth client and redirect URI, `genrecleanup`, Data Access scope)
  - `docs/youtube-audit/architecture.md` and `user-flows.md`: peer research (Non-Authorized, 29-day hide), Analytics (optional grant, deleted on revoke), calculated numbers labeled, no aggregation, no model-written statistics, Sentry redaction
  - `src/routes/privacy/+page.svelte`: analytics sharing, peer research, 30-day deletion, disconnect deletes results, what Sentry keeps; update its test if it asserts text
- [ ] T046 [P] Config for the unstable environment (research R17, inventory #26; repo config, list each in the report):
  - `service.yaml`: env `RESEARCH_QUEUE`, `RESEARCH_TASK_URL`, `RESEARCH_TASK_SA`; `PEER_HEARING` per T005
  - `deploy.sh`: `APP_DOMAIN="${APP_DOMAIN:-https://soundboard.anchildress1.dev}"`; `PROJECT_NUMBER` from `gcloud projects describe`; `RESEARCH_TASK_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app/api/research/task"`; enable `cloudtasks.googleapis.com` and `youtubeanalytics.googleapis.com`; create or update `soundboard-research` with `--max-concurrent-dispatches 1 --max-attempts 20 --min-backoff 10s --max-backoff 300s --max-retry-duration 3600s`; IAM per R2. Never run.
  - `.env.example` and the `README.md` env table: the four keys, with dev leaving the queue unset
- [ ] T047 Sweep, output recorded in the PR description:
  - `grep -rn "BRACKETS_ENABLED" src docs AGENTS.md service.yaml .env.example` → nothing
  - `grep -rnE "viewCount" src/lib/server/research` → nothing
  - no code sums, averages or counts statistics across channels: `grep -rnE "reduce\(|sum\(|avg\(" src/lib/server/research src/lib/server/jobs/view.ts` reviewed hit by hit
  - `git --no-pager diff 005-artist-branding -- package.json pnpm-lock.yaml` adds no dependency (SC-001)
  - no surname anywhere in the diff
- [ ] T048 After a rebase, if 005's migration number moved: delete this migration, its snapshot and journal entry, rerun `pnpm drizzle-kit generate --name fanbase_learning`, paste T006's appended SQL back, and rerun T008 and T049.
- [ ] T049 Validation loop (max 5 attempts, then stop with the exact errors):
  1. `make ai-checks`: coverage ≥ 85/85/85/80, zero warnings
  2. `pnpm exec playwright test`: both projects
  3. `semgrep scan --config auto --error --metrics=off` on changed files: zero findings
  4. SonarQube `analyze_code_snippet` on each changed or added source file: zero issues
  5. `pnpm audit --prod` and `pnpm audit`: zero
- [ ] T050 👤 Fixed-evidence evaluation E1 (quickstart E1, research R15, #20). ≈ $0.30 of the $0.50 share. Write `specs/006-fanbase-learning/eval/{fixture.ts,eval.test.ts,vitest.eval.config.ts}` (the config reuses the repo's aliases, unmocked `fetch`); run the three picks; record `eval/result.json` against R15's pass criteria. Read and log the ledger before each call. Any pick the share can't cover → **unverified**.
- [ ] T051 👤 Live local validation ([quickstart](quickstart.md) Q0–Q6). Gemini within what's left of the $0.50 share after T005 and T050.
  - Read and log `/private/tmp/claude-501/-Users-anchildress1-git-personal-soundboard/62e697ca-854d-4335-b7d9-d69a103885aa/scratchpad/gemini-ledger.md` before each call.
  - Dev `.env` and dev Neon branch only; `RESEARCH_QUEUE` unset.
  - A non-Nathan test user and channel; confirm on `/connections` it isn't Flies Like Robots, else stop and report. No upload.
  - One ≤ 60 s video from `$HOME/Downloads/*.mp4`, read only.
  - Record each Q step pass or fail; a spent share leaves the rest **unverified**, named.
- [ ] T052 👤 Operator, after deploy (never run by agents; deployment freeze): quickstart "After deploy" against `anchildress1-unstable` only.
- [ ] T053 👤 Owner, not a merge gate: attach YouTube's derived-metrics acceptance record to `docs/youtube-audit/` (plan O1); add `yt-analytics.readonly` to each OAuth client's Data Access; list it in the verification and YouTube audit submissions.

---

## Requirement coverage

| Req    | Tasks                                          |
| ------ | ---------------------------------------------- |
| FR-001 | T026, T030, T037, T038                         |
| FR-002 | T018, T033, T034, T035, T037                   |
| FR-003 | T016, T017, T018, T041, T042                   |
| FR-004 | T037                                           |
| FR-005 | T021, T026                                     |
| FR-006 | T026, T029, T030                               |
| FR-007 | T037, T038, T039                               |
| FR-008 | T026, T038, T050                               |
| FR-009 | T026                                           |
| FR-010 | T015, T026, T030, T036, T037                   |
| FR-011 | T018, T043                                     |
| FR-012 | T006, T008, T011, T030, T037, T040             |
| FR-013 | MAY; not used (research R13)                   |
| FR-014 | T030, T044                                     |
| FR-015 | T006, T008, T011, T019, T030, T037, T040, T047 |
| FR-016 | T019, T026, T030                               |
| FR-017 | T015, T021                                     |
| FR-018 | T015, T019, T020, T029, T030                   |
| FR-019 | T015, T030                                     |
| FR-020 | T021, T022, T026                               |
| FR-021 | T009, T024, T025                               |
| FR-022 | T027, T028, T029                               |
| FR-023 | T024, T029                                     |
| FR-024 | T027, T029                                     |
| FR-025 | T024, T026, T029, T041                         |
| SC-001 | T043, T047                                     |
| SC-002 | T026, T027, T029, T050                         |
| SC-003 | T015, T019, T020, T030                         |
| SC-004 | T038, T039                                     |
| SC-005 | T026, T038, T050                               |
| SC-006 | T017, T041                                     |
| SC-007 | T044                                           |
| SC-008 | T008, T011, T015, T026, T047                   |

## Dependencies and execution order

- **Setup (T001–T005):** T001 first commit; T003, T004 [P] after it. T002 before T006. T005 before T012's hearing part and T020.
- **Foundational (T006–T018)** blocks every story and lands green together: T006 → T007 → T008; T009, T010, T011, T014, T015 [P] beside T006; T012 after T005; T013 after T012; T016 after T010; T017 after T006, T016; T018 after T017.
- **US1 (T019–T032):** T019 (needs T014, T015) → T020 → T021; T022 after T021; T023 after T022; T024 → T025; T026 after T021, T022, T024; T027, T028 [P] beside T026; T029 after T013, T026–T028; T030 after T029; T031 after T019, T030; T032 last.
- **US2 (T033–T040):** T033 → T034 → T035 → T036 → T037; T038 after T026 and T037; T039 after T029; T040 after T006 and T037.
- **US3 (T041–T044):** after T018; T042 anytime; T043 after T029; T044 after T030.
- **Polish:** T045, T046 [P] after Foundational; T047 after every story; T048 at a rebase; T049 after T047; T050 after T049; T051 after T050; T052 at the first deploy; T053 before the first deploy.

## Parallel examples

- **Foundational:** T009 (`influence.ts`), T010 (`env.ts`), T011 (`genre-cleanup.ts`), T014 (`platforms/youtube/`), T015 (`calculated.ts`, `brackets.ts`, `stat-guard.ts`) beside T006.
- **US1:** T027 (`influence-check.ts`), T028 (`copy-check.ts`) beside T026.
- **Polish:** T045 docs beside T046 config.

## Implementation strategy

- **MVP:** Phases 1–3. Peers by sound, genre and bracket, sliders, citations and checks, review display, with outcomes unknown (`analytics-not-shared`).
- **Then** US2's learning and US3's continuity tests.
- **One PR** on `006-fanbase-learning`, stacked on `005-artist-branding`. Commits per task group, signed and atomic; T001 first.

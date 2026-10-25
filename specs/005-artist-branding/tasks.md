---
description: 'Task list for per-artist voice and brand guide'
---

# Tasks: Per-artist voice and brand guide

**Input**: Design documents from `specs/005-artist-branding/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/artist-guides.md](contracts/artist-guides.md), [quickstart.md](quickstart.md)

**Builds on**: `004-artist-profile`, final version (planned at `0a9176e`). Rebase onto it before T004. Every 004 name used below (`ownUploads(token, channelId, count, deadline)`, `accessTokenFor(uid, channelId, deadline)`, `requireCurated`, `GENERIC_VOICE`, `redactTurns` and `source: 'youtube'`, `uploadCount`, `artistProfile`, `USER_C`, the `reconnect YouTube` and `waiting on YouTube` waits) is checked against 004's code at that point; a renamed one is followed, not recreated.

**Tests**: Required. AGENTS.md and constitution V: positive, negative, error and edge-case tests for every new module.

- Unit tests in `tests/unit/`, mirroring `src/`; E2E in `tests/e2e/`.
- Import app code through `#lib/*` and `#src/*` with `.js` extensions.
- Mock only at process boundaries: YouTube and Gemini HTTP via `fetch`, KMS. PGlite with real migrations; Sentry through the global mock.
- Each task's tests are part of that task.

**Inventory**: `#n` points at the [plan's inventory](plan.md#inventory). Every entry is closed by a task below.

**Organization**: Setup, then a Foundational phase that must land as one green unit (the migration drops `curated` and `artist_memory` brand rows, so every reader changes with it), then one phase per user story. US1–US3 are P1, US4 is P2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1–US4
- 👤 Yours to run or approve.

---

## Phase 1: Setup (governance first)

**Purpose**: the constitution and PRD must allow the design before code changes behavior (constitution: code and PRD disagreeing is a stop).

- [ ] T001 Amend `.specify/memory/constitution.md` through `/speckit-constitution` (research R12). Version 3.0.0 → **4.0.0** (MAJOR; the next MAJOR if 004 didn't land 3.0.0), `Last Amended` = commit date, Sync Impact Report updated.
  - Delete 004's temporary exceptions: II's "Until spec 005 ships, artists without a curated profile get generic voice rules (`GENERIC_VOICE`)." and IV's "Until spec 005 ships, Nathan's `ARTIST_VOICE` and credit wording stay in `smart-pick.ts`, selected by `artists.curated`."
  - II, voice bullet: "Description voice MUST follow the owner's approved voice: proposed from their own writing (their YouTube descriptions and Soundboard edits), then edited and approved by them. Without an approved voice, drafts use generic plain-copy rules, never another artist's voice." Keep the peer-influence exception and the copied-phrase sentence as they are.
  - III, second exception: "One scheduled database retention job deletes expired YouTube data: statistics, and the inputs listed on voice and brand proposals."
  - Platform Terms, new bullet: "YouTube data read for a proposal MUST be kept at most 30 days, enforced by the database. Only artist-approved rules, holding no YouTube data, persist."
  - First commit of the PR, on its own. 👤 owner confirms the MAJOR classification in review.
- [ ] T002 [P] Update `docs/prd.md` (FR-013, inventory #20). Line numbers are `main`'s; after 004's T002 edits, edit the same bullets wherever they now sit, replacing 004's curated-only wording:
  - Non-Goals (line 45): per-artist voice and brand guide are in scope as of spec 005; visual identity (thumbnail style, colors) stays out.
  - R4 voice (line 100): replace the "Every run reads as Nathan until spec 005…" bullet with: the description follows the owner's approved voice (rules the artist approved from a proposal built on their own YouTube descriptions and Soundboard edits); without one, generic plain-copy rules; never another artist's. Content rules outrank the voice: candidate-only tags and hashtags, ffmpeg-only numbers, YouTube limits, never-invented facts. Spelling and grammar correction stays.
  - R4 Bandcamp (line 105): Bandcamp About in the artist's voice (approved or generic).
  - R12 (line 194): every artist proposes a voice (own 30 newest uploads' descriptions through their grant, minus Soundboard's own publishes, plus their Soundboard edits) and a brand guide (30 uploads + 10 thumbnails through their grant). Each proposal lists its sources, expires after 30 days, and is deleted daily. The artist edits and approves; only approved rules are kept, with source counts, no video IDs or titles. Nathan's earlier voice and brand guide carried over as approved.
  - Observability (line 185): agents list gains `voice-guide`.
  - Platforms (line 216): `gemini-4-argon` also for the voice guide.
  - Data table (line 240): `artist_memory` loses the brand slots; new row `artist_guides`: per artist, voice and brand, one proposal (30-day expiry) and one approved version each.
  - Retention bullet in R4 (line 97): the daily Neon Function also deletes expired proposals.
  - UX header (line 254): Menu shows Brand for every user with an artist profile.
- [ ] T003 [P] Update `AGENTS.md` (FR-013, inventory #20):
  - Content, voice line (004's `ARTIST_VOICE`/`curated` wording) → "Description voice: the owner's approved voice from `artist_guides`; without one, `GENERIC_VOICE` in `src/lib/server/ai/smart-pick.ts` and no credit line. NEVER put an artist's voice or credit wording in code. Change `GENERIC_VOICE` only on new evidence."
  - Data and access, YouTube terms line: add "Voice and brand proposals keep their source list (video ID, title, date) for at most 30 days; the database hides them and deletes them daily. Approved guides hold counts, never video IDs or titles." Scope 004's "NEVER store identity-read uploads" line to the pick's identity reads.
  - Data and access, 004's "Only a user with a curated profile opens `/brand`" → "`/brand` and `/api/guides/*` need an artist profile; guides are keyed by the caller's `users.artist_id`."
  - Sentry line: 004's `source: 'youtube'` rule also covers the voice request's uploads.
  - Architecture, exceptions: "one scheduled database job that deletes expired YouTube data (statistics and proposals)".
  - Architecture, model calls: "smart pick, brand and voice `medium`, hook `low`, each 8192 tokens".

---

## Phase 2: Foundational (blocks every story)

**Purpose**: table, migration, retention, shared types, guide storage, and every `curated` / `ARTIST_VOICE` / `artist_memory` brand reader. One commit group; `make ai-checks` green at the end.

**⚠️ CRITICAL**: no story work until this checkpoint is green.

- [ ] T004 Schema and migration (data-model, research R1–R4, inventory #8):
  - **`src/lib/server/core/schema.ts`:** add `artistGuides` (`artist_guides`) exactly as data-model:
    - `id integer` PK `generatedAlwaysAsIdentity()`; `artist_id text not null references artists(id)`
    - `kind text` with `CHECK kind in ('voice', 'brand')`; `status text` with `CHECK status in ('proposed', 'approved')`
    - `body jsonb not null`, `sources jsonb not null`, `proposed_at timestamptz not null`, `approved_at timestamptz` null
    - `CHECK (status = 'approved') = (approved_at is not null)`
    - `artist_guides_sources_check`: `(status = 'proposed' and jsonb_typeof(sources->'uploads') = 'array') or (status = 'approved' and jsonb_typeof(sources->'uploads') = 'number')`
    - `unique('artist_guides_slot').on(artist_id, kind, status)`
    - `index('artist_guides_expiry_idx').on(proposed_at).where(status = 'proposed')`
    - policies `guides_read`, `guides_insert`, `guides_update`, `guides_delete` to `soundboard_app` exactly as the data-model RLS list (own, fresh, approved-only writes, proposal-only deletes)
    - `guides_cleanup_read` (select) and `guides_cleanup_delete` (delete) to `soundboard_cleanup`: `status = 'proposed' and proposed_at <= now() - interval '30 days'`
  - `artistMemory.kind` enum and `artist_memory_kind_check` drop `brand` (inventory #6: `memoryOf`'s kind type in `src/lib/server/artist/memory.ts` follows; fix what the typecheck flags). `artists.curated` removed.
  - **Generate:** `pnpm drizzle-kit generate --name artist_guides`.
  - **Before committing,** edit the generated SQL in `drizzle/00NN_artist_guides.sql`:
    - Insert the data-model data block (steps 1–3) after `CREATE TABLE "artist_guides"` and its constraints, and before the `artist_memory_kind_check` change and `DROP COLUMN "curated"`.
    - Step 1's `DO` block raises `'Expected one curated artist'` unless exactly 1 row was inserted.
    - Step 1's `rules`: the 8 `ARTIST_VOICE` lines from `src/lib/server/ai/smart-pick.ts` without the leading `- ` and without the header line, verbatim, then `His credit line in his own wording, like "Written, performed, recorded, hacked and slashed by", with the credited name exactly as in recentUploads.` Copy them from the file, not from memory.
    - Append `ALTER TABLE artist_guides FORCE ROW LEVEL SECURITY`; `GRANT SELECT, INSERT (artist_id, kind, status, body, sources, proposed_at, approved_at), UPDATE (body, sources, proposed_at, approved_at), DELETE ON artist_guides TO soundboard_app`; `GRANT SELECT (id, status, proposed_at), DELETE ON artist_guides TO soundboard_cleanup`.
    - Append `CREATE FUNCTION public.soundboard_save_proposal(p_kind text, p_body jsonb, p_sources jsonb)` exactly as data-model specifies, with `REVOKE ALL … FROM PUBLIC` and `GRANT EXECUTE … TO soundboard_app`.
  - Never write Nathan's surname. No `flr` literal is needed (step 1 selects `WHERE curated`).
- [ ] T005 Update `tests/helpers/db.ts`: `truncate()` includes `artist_guides`; `Seed` gains `guides` rows inserted after `artists`.
- [ ] T006 Migration, RLS and retention-policy tests:
  - **New `tests/unit/drizzle/artist-guides.test.ts`** on its own `new PGlite()` using 004's migration-replay harness:
    - apply migrations up to 004's; seed privileged: Nathan's linked `users` row, an `artist_memory` brand `approved` row in 004's post-migration shape (`uploadCount: 3`, `createdAt`, `approvedAt`) and a brand `proposal` row; apply this migration
    - assert: Nathan's approved voice `body.rules` equals the 9 expected lines in order, `sources` `{uploads:0,edits:0,approvals:0,carriedOver:true}`; approved brand body equals the seeded statement and lists, `sources.uploads = 3`, no `uploadCount` key in `body`, `proposed_at`/`approved_at` from the seeded epoch ms; no proposal row; no `artist_memory` row with `kind = 'brand'`; no `curated` column
    - fail loud: the same harness with no curated artist makes the migration raise
  - **`tests/unit/lib/server/core/rls.test.ts` (extend):**
    - positive: a user reads and writes only their own guides
    - negative: another artist's guides invisible, updates change 0 rows; a proposal with `proposed_at` 30 days old invisible; a direct app `INSERT` of a `proposed` row refused; an approved insert with `proposed_at` in the future refused; an approved row with `sources.uploads` as an array refused (`CHECK`); an app `DELETE` of an approved row changes 0 rows
    - `soundboard_save_proposal`: inserts for the caller's artist; replaces a fresh and an expired (seeded 31 days back) proposal with a new `id`; `42501` with no identity or no profile; never touches the approved row
    - cleanup role: sees and deletes only expired proposals; never an approved row or a fresh proposal; can't read `body` or `sources`
- [ ] T007 [P] Shared types in `src/lib/brand.ts` (data-model, inventory #11):
  - `VoiceRules`, `VOICE_RULES_MAX = 12`, `VOICE_RULE_MAX = 240`, `VOICE_UPLOADS = 30`.
  - `voiceError(voice)` with exactly: "Add at least one voice rule.", "Voice has more than 12 rules.", "A voice rule is over 240 characters."
  - `GuideKind`, `ProposalSources`, `SourceSummary`, `Proposal<B>`, `Approved<B>`, `GuideState<B>`. Delete `StoredBrand`.
  - Tests in `tests/unit/lib/brand.test.ts`: 0, 1, 12 and 13 rules; 240 vs 241 characters; whitespace-only rules split away.
- [ ] T008 Create `src/lib/server/artist/guides.ts` (data-model, research R9, R10, inventory #5):
  - `getGuides(artistId)`, `approvedGuides(artistId)` (one query), `saveProposal(kind, body, sources)` (calls `soundboard_save_proposal`; `proposed_at` is always the database's `now()`), `approveGuide(artistId, kind, proposalId, body)`, `discardProposal(artistId, kind, proposalId)`.
  - Approve/discard: one transaction; `SELECT … FOR UPDATE` the pending row; missing or other `id` → `ActionError(409, 'The guide changed in another tab. Reload to see it.')`; approve upserts the approved row with `ON CONFLICT (artist_id, kind, status) DO UPDATE SET body, sources, proposed_at, approved_at` (those four only) and `sources` collapsed to `{ uploads: <length>, edits, approvals, carriedOver: false }`, then deletes the proposal.
  - Tests in `tests/unit/lib/server/artist/guides.test.ts`:
    - propose → approve → active; propose twice → one pending row with a new `id`, `proposed_at` from the database, and an approve naming the old `id` → 409
    - approve then approve the same `id` → 409; approve then discard → 409; discard then approve → 409
    - expired proposal (seeded 30 days back) → 409
    - approval keeps an extra column untouched: in the test, `ALTER TABLE artist_guides ADD COLUMN probe text` on the PGlite instance, set it on the approved row, re-approve, assert it's unchanged (R10)
    - approved `sources` has counts only
    - another artist's `proposalId` → 409, their rows unchanged
- [ ] T009 [P] Retention job (research R4, inventory #9):
  - `src/lib/server/core/genre-cleanup.ts`: add `DELETE_EXPIRED_PROPOSALS = "delete from artist_guides where status = 'proposed' and proposed_at <= now() - interval '30 days' returning id"`; `handleGenreCleanup` runs it after the evidence delete and answers `{ deleted, proposals }`. Either failing → 500, as today.
  - `functions/genrecleanup.ts` needs no change beyond the import; confirm.
  - Extend `tests/unit/lib/server/core/genre-cleanup.test.ts`: both counts; fresh proposals and approved rows survive; a failing second statement → 500.
- [ ] T010 [P] Agent `voice-guide` (research R5, inventory #10): `src/lib/server/core/tracing.ts` `AgentName` gains `'voice-guide'`; `src/lib/server/ai/model.ts` `AGENTS['voice-guide'] = { model: pickModel, thinkingLevel: 'medium', maxTokens: 8192, minCallMs: 33_000 }`. Extend `tests/unit/lib/server/ai/model.test.ts`: the call sends `thinkingLevel: 'medium'`, `store: false`, no `mediaResolution`.
- [ ] T011 Remove `curated` (research R2, R11, inventory #7, #17):
  - `src/lib/server/artist/profile.ts`: `ArtistProfile` drops `curated`.
  - `src/routes/+layout.server.ts`: layout `artist` drops `curated`.
  - `src/routes/+layout.svelte`: the menu link reads "Brand" and shows for every user with `data.artist`.
  - Replace 004's `requireCurated` with `requireArtist(user)` in `src/lib/server/artist/profile.ts` (a profile gate shared by brand and voice routes): `error(404, 'Not found')` unless `user?.artist`. Tests in `tests/unit/lib/server/artist/profile.test.ts`.
  - Update `tests/unit/routes/layout.test.ts`, `layout.server.test.ts`, `tests/unit/lib/server/auth/users.test.ts`, and the profile tests.
- [ ] T012 Brand storage on `artist_guides` and the new routes (research R6, R11, contract, inventory #3, #12–#14):
  - `src/lib/server/artist/brand.ts`: delete the `artist_memory` slots, `getBrand`, `approvedBrand`, `approveBrand`, `discardBrandProposal`. `proposeBrand(user)` keeps its prompt, limits and cleaning, keeps 004's `accessTokenFor(uid, channelId, deadline)` → `ownUploads(token, channelId, BRAND_VIDEOS, deadline)` through the caller's grant, and calls `saveProposal` with `sources = { uploads: [{ videoId, title, publishedAt }], edits: 0, approvals: 0, thin: false }`. Grant handling per research R8: no connection, `no_channel`, `revoked`, `missing_scopes`, null token, 401/403 → `{ wait: 'reconnect YouTube' }` before any model call (401/403 also marks the connection refused); YouTube busy → `{ wait: 'waiting on YouTube' }`; `app-rejected` → error, as 004. 004's `409 "Connect YouTube to read your channel."` is removed if 004 kept it. 004's `uploadCount` on proposals is replaced by `sources`. `thumbnailImage` gets the same deadline. Sentry: the brand request's uploads part stays tagged `source: 'youtube'` (004), so spans show `[YouTube uploads: <n>]`.
  - `src/params/guide.ts`: matcher, `brand` only for now (US1 adds `voice`).
  - `src/routes/api/guides/[kind=guide]/{propose,approve,discard}/+server.ts`: `requireArtist`, then dispatch by `kind`. Approve body `{ proposalId, statement, keep, fix, drop }` validated by `isBrandGuide` + `guideError`; discard body `{ proposalId }`. Status codes and messages exactly as the contract.
  - Delete `src/routes/api/brand/` and its tests in `tests/unit/routes/api/brand/`.
  - `src/lib/api.ts`: `proposeGuide(kind)`, `approveGuide(kind, body, proposalId)`, `discardGuide(kind, proposalId)`; delete the three brand functions.
  - `src/routes/brand/+page.server.ts` returns `getGuides(locals.user.artist.id)`, shaped `{ voice: GuideState<VoiceRules>, brand: GuideState<BrandGuide> }`. `src/routes/brand/+page.svelte` keeps today's brand form on the new shapes (the voice section comes in US1).
  - Tests: rewrite `tests/unit/lib/server/artist/brand.test.ts` (sources stored with titles; bearer is the caller's; no `statistics` part; reconnect wait marks refusal; never connected → reconnect wait with 0 YouTube and 0 Gemini calls; zero uploads 409; busy and quota waits store nothing; deadline passed to YouTube and thumbnail fetches; Sentry span input holds no upload title or description) and add `tests/unit/routes/api/guides/{propose,approve,discard}/server.test.ts` (401 signed out, 404 no profile, 404 unknown kind, 400/422/409/200 per the contract).
- [ ] T013 Picks read the approved guides (research R7, inventory #1, #2):
  - `src/lib/server/ai/smart-pick.ts`:
    - delete `ARTIST_VOICE` and 004's curated credit block; `PickContext.artist` = `{ name; contactLine }`; add `voice: VoiceRules | null`
    - `voiceBlock(voice)`: approved → `"Write the description the way the artist writes their own:"` then `- <rule>` per rule; null → `GENERIC_VOICE`
    - right after the voice block, every run: `"These content rules outrank the voice rules: hashtags and tags only from candidateLists, no numbers except ffmpeg's, YouTube length limits, and facts, credits and links only from artistNotes, facts and recentUploads. Never write placeholders."`
    - credit lines (research R7): approved voice → "Write a credit line only as the voice rules say, with the credited name exactly as in recentUploads" and `bandcamp.credits` from the description; no approved voice → 004's "Write no credit line" and `''`. 004's app-placed contact line is unchanged
  - `src/lib/server/pipeline/pipeline.ts` `pick()`: when `artistJob(job)`, `approvedGuides(job.artistId)` gives `voice` and `brand`; otherwise `voice: null`, `brand: null`. Same deadline; no extra YouTube call.
  - Tests in `tests/unit/lib/server/ai/smart-pick.test.ts` and `tests/unit/lib/server/pipeline/pipeline.test.ts`:
    - **Nathan (SC-003):** on the migrated database, his prompt contains each of the 8 earlier `ARTIST_VOICE` rule lines (as golden strings in the test file) and the credit example, in order, and no `GENERIC_VOICE` text; the brand block equals his approved guide
    - user C with no approved voice → `GENERIC_VOICE`, no Nathan rule text, no brand block (FR-006)
    - user C with an approved voice → exactly C's rules; none of Nathan's (SC-002)
    - the content-rules line follows the voice block on every run (FR-008)
    - a job whose `artistId` differs from the owner's current link → no guides read
    - approving a new voice mid-review changes no `jobs` row (FR-011, SC-006): snapshot the `picks` and `data` columns (which hold `finalFields`) of an `APPROVED` and a `REVIEW` job before and after `approveGuide`, byte-identical
    - the hook prompt (`buildHookRequest`) carries no voice block (FR-007)
- [ ] T014 Fixtures:
  - `tests/helpers/pipeline.ts`: guide seed helpers `approvedVoice(artistId, rules)`, `approvedBrandGuide(artistId, guide)`, `pendingProposal(artistId, kind, { proposedAt })`. Nathan's guides come from the migration.
  - `tests/e2e/fakes/fixtures.ts`: user C has no guides and is read-only in E2E. For the tests that write (T019 approve, T026 race), add per-project users `brand-desktop@example.com` / `brand-pixel@example.com` (profiles `artist-bd` / `artist-bp`, one seeded pending voice proposal each) and `race-desktop@example.com` / `race-pixel@example.com` (profiles `artist-rcd` / `artist-rcp`, one seeded pending voice proposal each). `tests/e2e/session.ts` picks the user by `testInfo.project.name`, as 004 does.
  - `tests/e2e/fakes/youtube.ts`: the owner-grant upload reads answer for user C's channel `UCtest` with 3 uploads with prose descriptions, so voice and brand proposals reach the model call (which the Gemini preload answers 429).

**Checkpoint**: `make ai-checks` green. Nathan's picks unchanged (T013 golden test). Brand page works on the new table.

---

## Phase 3: User Story 1 — Propose and approve my voice (P1) 🎯 MVP

**Goal**: an artist proposes a voice from their own descriptions and Soundboard edits, edits it, approves it, and their next pick follows it.

**Independent Test**: as user C (unit, Gemini and YouTube `fetch` faked): propose → sources list C's uploads and edit counts → edit one rule → approve → the next pick's prompt carries exactly C's rules.

- [ ] T015 [US1] Create `src/lib/server/artist/voice.ts` (research R5, R8, inventory #4):
  - `voiceEvidence(artistId, uploads)`: drop uploads whose `videoId` matches the artist's `publish` memory keys; clip descriptions to 1,500 characters; `recentFeedback(artistId, 60)` → EDITED `title`/`description` rows (before/after clipped to 600) and ACCEPTED rows (final title only); SKIPPED and tag edits dropped; `thin = proseDescriptions + strongEdits < 5`, prose = ≥ 15 words after removing URLs and `#hashtags`.
  - `VOICE_SCHEMA` `{ rules: string[] }`, `isVoiceRules`, `buildVoiceRequest(evidence)` with the R5 system rules verbatim and the 3-rule cap when thin; `cleanVoice` (`stripDeep`, trim, case-insensitive dedupe, cap 12 × 240).
  - `proposeVoice(user)`: `stepDeadline()` at entry; `accessTokenFor(uid, channelId, deadline)` → `ownUploads(token, channelId, VOICE_UPLOADS, deadline)`; grant handling per research R8 (`reconnect YouTube` wait on revoked, missing scopes, null token, 401/403 with refusal marked; never connected or `no_channel` → edits only); no usable uploads and no EDITED rows → `409 "Nothing to learn from yet. Connect YouTube or finish a few releases first."` before any model call; `invokeAgent('voice-guide', …)` with `chatJson` and the shared deadline; busy/quota → `{ wait }`; unparsed → `502 "The model reply did not parse as a voice."`; else `saveProposal` with `{ uploads: [{videoId, title, publishedAt}], edits, approvals, thin }`.
  - Sentry: the uploads go in their own text part tagged `source: 'youtube'` (004 R13), so `redactTurns` shows `[YouTube uploads: <n>]`; edits and the reply stay in the span.
  - Tests in `tests/unit/lib/server/artist/voice.test.ts`:
    - positive: request carries C's descriptions and edits; stored proposal lists the uploads read and the counts
    - Soundboard-published video excluded; SKIPPED rows and tag edits excluded
    - thin evidence: `thin: true` and the prompt's 3-rule cap
    - US1 AS4: no channel and no edits → 409, 0 Gemini and 0 YouTube calls
    - edits only, never connected → proposal with `uploads: []`
    - revoked connection → `reconnect YouTube`, no model call; 401 mid-read → wait, connection marked refused, no proposal stored, approved voice untouched
    - busy 429, per-day 429 → waits, nothing stored; unparsed twice → 502
    - no `statistics` in any `part`, no comment endpoint called (FR-003)
    - model-emitted numbers stripped; 13 rules capped at 12
    - Sentry span input holds no description text, only `[YouTube uploads: <n>]`
    - a credited full name in a description (fixture name `Credit Person`) reaches the model request unchanged: nothing filters names from runtime data (spec edge case)
- [ ] T016 [US1] Voice routes: `src/params/guide.ts` accepts `voice`; the three handlers dispatch `voice` to `proposeVoice` / `approveGuide` with `isVoiceRules` + `voiceError` / `discardProposal`. Extend the three route tests: voice 200s, 400 `"Expected voice rules."`, 422 per `voiceError`, 409 race, 404 no profile.
- [ ] T017 [P] [US1] Shared propose loop `src/lib/propose.ts`: `proposeUntilReady(kind, onWait, stopped)` with `pRetry` + `POLL_BACKOFF`, retrying only `model busy` and `waiting on YouTube`; `model quota spent` and `reconnect YouTube` abort with their `WAIT_TEXT`. Tests in `tests/unit/lib/propose.test.ts`: busy then success; YouTube busy then success; quota stops; reconnect stops; stop flag aborts; a thrown 409 surfaces its message.
- [ ] T018 [US1] `src/lib/components/VoiceGuide.svelte` and the Voice section of `src/routes/brand/+page.svelte` (contract):
  - Approved: rules list; "Carried over from your earlier rules" when `carriedOver`, else "From N uploads, M edits and K approvals, proposed <date>"; none → "Not set. Drafts use plain, generic rules."
  - Proposal: source list (title + date, linked to `https://www.youtube.com/watch?v=<id>`, `target=_blank rel="noopener noreferrer"`), edit and approval counts, "Little writing to learn from: N descriptions, M edits." when `thin`; one textarea, one rule per line; Approve and Discard, disabled while busy or when `voiceError` returns a message.
  - On a 409 the message shows and the textarea keeps its text.
  - Page `<title>`: "Brand · Soundboard"; `<h1>` "Brand".
  - Tests in `tests/unit/lib/components/VoiceGuide.test.ts` and `tests/unit/routes/brand/page.test.ts`.
- [ ] T019 [US1] E2E `tests/e2e/brand.spec.ts`, voice (both projects):
  - C opens `/brand` from the menu "Brand": Voice reads "Not set. Drafts use plain, generic rules."
  - Propose → `{ wait: 'model busy' }` from the 429 preload, the button shows the wait text, nothing stored.
  - As the per-project `brand-*` user (T014), with its seeded proposal: edit a rule, approve → the approved list shows it with counts.
  - B (no profile) → `/brand` 404 and `POST /api/guides/voice/propose` 404.

**Checkpoint**: US1 independently testable. Non-Nathan drafts follow their own approved voice.

---

## Phase 4: User Story 2 — Propose and approve my brand guide (P1)

**Goal**: every artist proposes, edits and approves their own brand guide, read through their own grant; picks follow it.

**Independent Test**: as C: propose brand (faked) → sources list C's uploads → approve → the next pick's prompt has C's brand block. Another user sees only their own.

- [ ] T020 [US2] `src/lib/components/BrandGuide.svelte` and the Brand guide section of `src/routes/brand/+page.svelte`: today's statement and keep / fix / drop editor moved into the component on the `Proposal`/`Approved` shapes, using `src/lib/propose.ts`, with the same source list as the voice. None approved: "Not set. Drafts run without one." 409 keeps the text. Update the help line to name the owner's own uploads. Tests in `tests/unit/lib/components/BrandGuide.test.ts` and `tests/unit/routes/brand/page.test.ts`.
- [ ] T021 [US2] Isolation and use (FR-007, FR-010, US2 AS2–AS3), in `tests/unit/lib/server/artist/guides.test.ts` and `tests/unit/lib/server/pipeline/pipeline.test.ts`:
  - with A (Nathan) and C both approved, A's pick carries only A's brand and C's only C's
  - C's `getGuides` never returns A's rows; a C session approving A's `proposalId` → 409 and A unchanged
  - a re-run pick and a Short's parent pick read the current approved guide
- [ ] T022 [US2] E2E `tests/e2e/brand.spec.ts`, brand (both projects):
  - C's Brand guide reads "Not set. Drafts run without one."; Propose reaches `model busy`
  - A sees his own approved guide, and C's page shows none of A's statement text (SC-002)
  - signed out: `/brand` → 303 home; `POST /api/guides/brand/propose` → 401

**Checkpoint**: US1 and US2 deliver the MVP for every non-Nathan artist.

---

## Phase 5: User Story 3 — Nathan keeps what he has (P1)

**Goal**: Nathan's voice and brand guide show approved with today's content; a later proposal replaces his only after approval.

**Independent Test**: on the migrated database, A's `/brand` shows both approved, "Carried over", and his pick prompt matches the golden rules (T013).

- [ ] T023 [US3] Replacement only on approval (US3 AS2), in `tests/unit/lib/server/artist/voice.test.ts`: as A, propose a new voice (faked) → `approvedGuides('flr')` still returns the carried-over rules; discard → unchanged; propose and approve → the new rules, `carriedOver: false`.
- [ ] T024 [US3] E2E `tests/e2e/brand.spec.ts`, Nathan: A opens `/brand` and sees Voice and Brand guide approved, the voice marked "Carried over from your earlier rules", and his first carried rule text ("Short, plain, literal.").

**Checkpoint**: Nathan's release flow unchanged; his guides visible and editable.

---

## Phase 6: User Story 4 — The voice stays current (P2)

**Goal**: new edits feed the next proposal; the active voice changes only on approval.

**Independent Test**: approve a voice for C, add EDITED feedback, propose again: the request carries the new edits, `approvedGuides` is unchanged until approval.

- [ ] T025 [US4] In `tests/unit/lib/server/artist/voice.test.ts`:
  - after approval, 3 new EDITED rows → the next request's edits include them, newest first
  - pending proposal + the active voice → the pick uses the active voice (US4 AS1)
  - discard → active unchanged (US4 AS2)
  - a Short approval's EDITED rows count as evidence; no ACCEPTED row is written for it (AGENTS.md)
- [ ] T026 [US4] Race in the UI (spec edge case): `tests/e2e/brand.spec.ts`, two pages for the per-project `race-*` user (T014) on its seeded proposal: approve in page 1, approve in page 2 → "The guide changed in another tab. Reload to see it.", page 2's textarea still holds its edit, and a reload shows page 1's approved rules.

**Checkpoint**: all four stories independently testable.

---

## Phase 7: Polish and validation

- [ ] T027 [P] Docs (inventory #18, #21):
  - `docs/operations/youtube-retention.md`: the daily job also deletes voice and brand proposals 30 days after `proposed_at`; the response reports `proposals`; `soundboard_cleanup` sees only `(id, status, proposed_at)` of expired proposals.
  - `docs/youtube-audit/architecture.md`: proposals read the artist's own uploads through their grant, expire in 30 days; approved rules are kept as the artist's own statement (owner's III.E.4.h interpretation) with counts only.
  - `README.md` brand section: every artist proposes and approves a voice and a brand guide on `/brand`.
  - `src/routes/privacy/+page.svelte`: each artist profile stores voice and brand proposals (with the uploads they read, deleted after 30 days) and the approved rules. Update its test if one asserts the text.
- [ ] T028 Sweep: `grep -rnE "ARTIST_VOICE|curated|StoredBrand|uploadCount|/api/brand|requireCurated|kind: 'brand'" src scripts functions` returns nothing. Migrations and tests may keep historic text. Record the output in the PR description.
- [ ] T029 Validation loop (brief; max 5 attempts, then stop with the exact errors):
  1. `make ai-checks`: coverage ≥ 85/85/85/80, zero warnings
  2. `pnpm exec playwright test`: both projects
  3. `semgrep scan --config auto --error --metrics=off` on changed files: zero findings
  4. SonarQube `analyze_code_snippet` on each changed or added source file (`anchildress1_soundboard`): zero issues
  5. `pnpm audit --prod` and `pnpm audit`: zero
- [ ] T030 👤 Live local validation, [quickstart Q4](quickstart.md#q4--live-local-validation-us1-us2-gemini-share--040). Gemini share ≤ $0.40.
  - Read `/private/tmp/claude-501/-Users-anchildress1-git-personal-soundboard/62e697ca-854d-4335-b7d9-d69a103885aa/scratchpad/gemini-ledger.md` before each call; log each call.
  - Dev Neon branch only; a non-Nathan seeded user with a saved profile and a connected test channel (confirm it isn't Flies Like Robots).
  - One voice proposal and one brand proposal: approve both after an edit. Record SC-001 time and the `voice-guide` latency against `minCallMs`.
  - Two-tab race and disconnected brand proposal (reconnect wait) per Q4.
  - Optional single pick on the shortest `$HOME/Downloads/*.mp4` only if the ledger has room. No approval, no upload.
  - Report calls, tokens, spend.
- [ ] T031 👤 After merge and operator authorization (deployment freeze): redeploy `genrecleanup` per `docs/operations/youtube-retention.md` and confirm one scheduled run reports `proposals` (quickstart Q5).
- [ ] T032 After the rebase onto 004's final version (and 003 if it lands a migration): if the migration number moved, delete this migration, its snapshot and journal entry, rerun `pnpm drizzle-kit generate --name artist_guides`, and paste the T004 data block and grants back. Rerun T006 and T029.
- [ ] T033 👤 Post-release: quickstart Q6 blind comparison with an artist (SC-005). Not a merge gate.

---

## Dependencies and execution order

- **Setup (T001–T003)** first. T001 is the PR's first commit; T002 and T003 run in parallel after it.
- **Foundational (T004–T014)** blocks every story and lands green as a group:
  - T004 → T005 → T006.
  - T007, T009, T010 [P] beside T004.
  - T008 needs T004, T005, T007.
  - T011 needs T004.
  - T012 needs T008 and T011.
  - T013 needs T008 and T011.
  - T014 after T005; its E2E parts before T019.
- **US1 (T015–T019):** T015 → T016; T017 [P] beside T015; T018 needs T016 and T017; T019 last.
- **US2 (T020–T022):** after T012 and T017. Independent of US1 except the shared page file (`+page.svelte`): do T018 and T020 in sequence, not in parallel.
- **US3 (T023–T024):** after T015 (T023) and T018 (T024).
- **US4 (T025–T026):** after T015, T016 and T018.
- **Polish (T027–T033):** T027 [P] anytime after T012. T028 after every story. T029 after T028. T030 after T029. T031 after merge. T032 at rebase. T033 after release.

## Parallel examples

- **Foundational:** T007 (`src/lib/brand.ts`), T009 (`genre-cleanup.ts`) and T010 (`model.ts`, `tracing.ts`) beside T004.
- **US1:** T017 (`src/lib/propose.ts`) beside T015 (`voice.ts`).
- **Polish:** T027 docs beside any story phase.

## Implementation strategy

- **MVP:** Phases 1–4. Every artist proposes and approves both a voice and a brand guide, and Nathan's drafts are unchanged from the Foundational checkpoint on.
- **Then** US3's checks and US4's evidence and race coverage.
- **One PR** on `005-artist-branding`, stacked on `004-artist-profile`. Commits per task group, signed and atomic; T001 first.

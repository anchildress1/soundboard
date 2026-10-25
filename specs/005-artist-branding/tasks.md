---
description: 'Task list for per-artist voice and brand guide'
---

# Tasks: Per-artist voice and brand guide

**Input**: Design documents from `specs/005-artist-branding/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/artist-guides.md](contracts/artist-guides.md), [quickstart.md](quickstart.md)

**Builds on**: `004-artist-profile`, final plan at `7256ea4`. Rebase onto its merged code before T005. Every 004 name used below (`ownUploads(token, channelId, count, deadline)`, `accessTokenFor(uid, channelId, deadline)`, `identityFailure`, `budgetSignal`, `DeadlineSpent`, `hasModelTime`, `requireCurated`, `GENERIC_VOICE`, `redactTurns` and `source: 'youtube'`, `uploadCount`, `artistProfile`, `USER_C`, the `reconnect YouTube` and `waiting on YouTube` waits) is checked against 004's code at that point; a renamed one is followed, not recreated.

**Tests**: Required. AGENTS.md and constitution V: positive, negative, error and edge-case tests for every new module.

- Unit tests in `tests/unit/`, mirroring `src/`; E2E in `tests/e2e/`.
- Import app code through `#lib/*` and `#src/*` with `.js` extensions.
- Mock only at process boundaries: YouTube and Gemini HTTP via `fetch`, KMS. PGlite with real migrations; Sentry through the global mock.
- Each task's tests are part of that task.

**Inventory**: `#n` points at the [plan's inventory](plan.md#inventory). Every entry is closed by a task below.

**Organization**: Setup and the timing gate, then a Foundational phase that must land as one green unit (the migration drops `curated` and `artist_memory` brand rows, so every reader changes with it), then one phase per user story. US1–US3 are P1, US4 is P2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1–US4
- 👤 Yours to run or approve.

---

## Phase 1: Setup (governance first, then the timing gate)

**Purpose**: the constitution and PRD must allow the design before code changes behavior (constitution: code and PRD disagreeing is a stop). The voice call's time budget is measured before code depends on it.

- [x] T001 Amend `.specify/memory/constitution.md` through `/speckit-constitution` (research R12). Version 3.0.0 → **4.0.0** (MAJOR; the next MAJOR if 004 didn't land 3.0.0), `Last Amended` = commit date, Sync Impact Report updated.
  - Delete 004's temporary exceptions: II's "Until spec 005 ships, artists without a curated profile get generic voice rules (`GENERIC_VOICE`)." and IV's "Until spec 005 ships, Nathan's `ARTIST_VOICE` and credit wording stay in `smart-pick.ts`, selected by `artists.curated`."
  - II, voice bullet: "Description voice MUST follow the owner's approved voice: proposed from their own writing (their YouTube descriptions and Soundboard edits), then edited and approved by them. Without an approved voice, drafts use generic plain-copy rules, never another artist's voice." Keep the peer-influence exception and the copied-phrase sentence as they are.
  - III, second exception: "One scheduled database retention job deletes expired YouTube data: statistics, and the inputs listed on voice and brand proposals."
  - Platform Terms, new bullet: "YouTube data read for a proposal MUST be kept at most 30 days, enforced by the database. Only artist-approved rules, holding no YouTube data, persist."
  - III's claim rule is unchanged; proposals claim (research R8).
  - First commit of the PR, on its own. 👤 owner confirms the MAJOR classification in review.
- [x] T002 [P] Update `docs/prd.md` (FR-013, inventory #20). Line numbers are `main`'s; after 004's T002 edits, edit the same bullets wherever they now sit, replacing 004's curated-only wording:
  - Non-Goals (line 45): per-artist voice and brand guide are in scope as of spec 005; visual identity (thumbnail style, colors) stays out.
  - R4 voice (line 100): replace the "Every run reads as Nathan until spec 005…" bullet with: the description follows the owner's approved voice (rules the artist approved from a proposal built on their own YouTube descriptions, their approved Soundboard drafts at lower weight, and their Soundboard edits); without one, generic plain-copy rules; never another artist's. Hook picks write their reason in the current voice; Shorts inherit the parent's approved fields. Content rules outrank the voice: candidate-only tags and hashtags, ffmpeg-only audio figures, YouTube limits, never-invented facts. Spelling and grammar correction stays.
  - R4 Bandcamp (line 105): Bandcamp About in the artist's voice (approved or generic).
  - R11 observability: the `voice-guide` and `brand-guide` reply and reasoning are recorded as `[guide proposal: <n> chars]`, since they restate YouTube data; every other agent keeps its reply text.
  - R12 (line 194): every artist proposes a voice (own 30 newest uploads' descriptions through their grant, Soundboard drafts marked and weighted lower, plus their Soundboard edits) and a brand guide (30 uploads + 10 thumbnails through their grant). Each proposal lists its sources, is hidden after 29 days and deleted daily, and is deleted on disconnect. The artist edits and approves; only approved rules are kept, with source counts, no video IDs or titles. Nathan's earlier voice (with his credit wording as a rule) and brand guide carried over as approved.
  - Observability (line 185): agents list gains `voice-guide`.
  - Platforms (line 216): `gemini-4-argon` also for the voice guide.
  - Data table (line 240): `artist_memory` loses the brand slots; new rows `artist_guides` (per artist, voice and brand, one proposal and one approved version each) and `guide_claims` (the proposal claim and quota hold).
  - Retention bullet in R4 (line 97): the daily Neon Function also deletes proposals 29 days after their claim.
  - UX header (line 254): Menu shows Brand for every user with an artist profile.
- [x] T003 [P] Update `AGENTS.md` (FR-013, inventory #20):
  - Content, voice line (004's `ARTIST_VOICE`/`curated` wording) → "Description voice: the owner's approved voice from `artist_guides`; without one, `GENERIC_VOICE` in `src/lib/server/ai/smart-pick.ts` and no credit line. NEVER put an artist's voice or credit wording in code. Change `GENERIC_VOICE` only on new evidence."
  - Content, audio line: unchanged; the pick's content-rules line restricts audio figures only.
  - Data and access, YouTube terms line: add "Voice and brand proposals keep their source list (video ID, title, date) from the claim until the database hides them at 29 days and the daily job deletes them; disconnect deletes them. Approved guides hold counts, never video IDs or titles." Scope 004's "NEVER store identity-read uploads" line to the pick's identity reads.
  - Data and access, 004's "Only a user with a curated profile opens `/brand`" → "`/brand` and `/api/guides/*` need an artist profile; guides are keyed by the caller's `users.artist_id`. A foreign or stale `proposalId` → 404."
  - Sentry line: 004's `source: 'youtube'` rule also covers the voice request's uploads. Add: "`voice-guide` and `brand-guide`: record reply and reasoning as `[guide proposal: <n> chars]`, including a re-ask's resent reply."
  - Architecture, exceptions: "one scheduled database job that deletes expired YouTube data (statistics and proposals)".
  - Architecture, claims: "Guide proposals claim (artist, kind) in `guide_claims` with the same token pattern."
  - Architecture, model calls: "smart pick, brand and voice `medium`, hook `low`, each 8192 tokens".
- [x] T004 👤 Voice timing gate (research R5, Codex #14). Runs at implementation start, before T011 and T016. Docs and ledger only; nothing committed to `src/`.
  - Read `/private/tmp/claude-501/-Users-anchildress1-git-personal-soundboard/62e697ca-854d-4335-b7d9-d69a103885aa/scratchpad/gemini-ledger.md` first; log the call there (agent, model, tokens, cost, latency).
  - A throwaway script outside the repo sends one request through `chat` in `src/lib/server/ai/model.ts` with the `brand-guide` settings (same model, `medium`, 8,192 tokens).
  - Request: the R5 system rules, and evidence at the caps: 30 descriptions of 1,500 characters and 60 EDITED rows of 600 + 600 characters. Fill it from the test channel's own descriptions, repeated as needed. Never Nathan's channel.
  - Expected cost: about $0.05 input + up to $0.08 output.
  - **Pass:** latency ≤ 33 s, and 15 s + 2 × `minCallMs` ≤ 110 s.
  - **Fail:** set the planned `minCallMs` for T011 to the measured value, rounded up to the next second. If the re-ask no longer fits, lower `VOICE_UPLOADS` and the edit count in research R5 and data-model, then measure again.
  - Record the measured latency and the chosen `minCallMs` in research R5.

---

## Phase 2: Foundational (blocks every story)

**Purpose**: tables, migration, retention, shared types, guide storage and claims, Sentry redaction, disconnect cleanup, and every `curated` / `ARTIST_VOICE` / `artist_memory` brand reader. One commit group; `make ai-checks` green at the end.

**⚠️ CRITICAL**: no story work until this checkpoint is green.

- [x] T005 Schema and migration (data-model, research R1–R4, inventory #8):
  - **`src/lib/server/core/schema.ts`:** add `artistGuides` (`artist_guides`) exactly as data-model:
    - `id integer` PK `generatedAlwaysAsIdentity()`; `artist_id text not null references artists(id)`
    - `kind text` with `CHECK kind in ('voice', 'brand')`; `status text` with `CHECK status in ('proposed', 'approved')`
    - `body jsonb not null`, `sources jsonb not null`, `proposed_at timestamptz not null`, `approved_at timestamptz` null
    - `CHECK (status = 'approved') = (approved_at is not null)`
    - `artist_guides_sources_check` exactly as data-model: exact keys and types per status, every comparison `IS NOT DISTINCT FROM`
    - `unique('artist_guides_slot').on(artist_id, kind, status)`
    - `index('artist_guides_expiry_idx').on(proposed_at).where(status = 'proposed')`
    - policies `guides_read`, `guides_insert`, `guides_update`, `guides_delete` to `soundboard_app` exactly as data-model (own, fresh at 29 days, approved-only writes, proposal-only deletes). The own predicate compares `u.artist_id = ${t.artistId}`, table-qualified, as `memory_artist` does.
    - `guides_cleanup_read` (select) and `guides_cleanup_delete` (delete) to `soundboard_cleanup`: `status = 'proposed' and proposed_at <= now() - interval '29 days'`
  - **Also add `guideClaims` (`guide_claims`)** exactly as data-model: PK `(artist_id, kind)`, `claim_token`, `claimed_at`, `claim_until`, `limit_until`; `claims_own` policy with `${t.artistId}`.
  - `artistMemory.kind` enum and `artist_memory_kind_check` drop `brand` (inventory #6: `memoryOf`'s kind type in `src/lib/server/artist/memory.ts` follows; fix what the typecheck flags). `artists.curated` removed.
  - **Generate:** `pnpm drizzle-kit generate --name artist_guides`.
  - **Before committing,** edit the generated SQL in `drizzle/00NN_artist_guides.sql`:
    - Insert the data-model data block (steps 1–3) after both `CREATE TABLE`s and their constraints, and before the `artist_memory_kind_check` change and `DROP COLUMN "curated"`.
    - Step 1's `DO` block raises `'Expected one curated artist'` unless exactly 1 row was inserted.
    - Step 1's `rules`: the 8 `ARTIST_VOICE` lines from `src/lib/server/ai/smart-pick.ts` without the leading `- ` and without the header line, verbatim, then `His credit line in his own wording, like "Written, performed, recorded, hacked and slashed by", with the credited name exactly as in recentUploads.` Copy them from the file, not from memory.
    - Append `FORCE ROW LEVEL SECURITY` on both tables.
    - Append grants: `GRANT SELECT, INSERT, UPDATE (body, sources, proposed_at, approved_at), DELETE ON artist_guides TO soundboard_app`; `GRANT SELECT (id, status, proposed_at), DELETE ON artist_guides TO soundboard_cleanup`; `GRANT SELECT, UPDATE (claim_token, claim_until, limit_until) ON guide_claims TO soundboard_app` (T036).
    - Append `CREATE FUNCTION public.soundboard_save_proposal(p_kind text, p_body jsonb, p_sources jsonb, p_claim_token text)` exactly as data-model's six steps, with `REVOKE ALL … FROM PUBLIC` and `GRANT EXECUTE … TO soundboard_app`.
  - Never write Nathan's surname. No `flr` literal is needed (step 1 selects `WHERE curated`).
- [x] T006 Update `tests/helpers/db.ts`: `truncate()` includes `artist_guides` and `guide_claims`; `Seed` gains `guides` rows inserted after `artists`.
- [x] T007 Migration, RLS and retention-policy tests:
  - **New `tests/unit/drizzle/artist-guides.test.ts`** on its own `new PGlite()` using 004's migration-replay harness. The only suite that asserts what the migration itself produces (R2):
    - apply migrations up to 004's; seed privileged: Nathan's linked `users` row, an `artist_memory` brand `approved` row in 004's post-migration shape (`uploadCount: 3`, `createdAt`, `approvedAt`) and a brand `proposal` row; apply this migration
    - assert: Nathan's approved voice `body.rules` equals `NATHAN_VOICE_RULES` (T015) in order, `sources` `{uploads:0,drafts:0,edits:0,approvals:0,carriedOver:true}`; approved brand body equals the seeded statement and lists, `sources.uploads = 3`, no `uploadCount` key in `body`, `proposed_at`/`approved_at` from the seeded epoch ms; no proposal row; no `artist_memory` row with `kind = 'brand'`; no `curated` column
    - fail loud: the same harness with no curated artist makes the migration raise
  - **`tests/unit/lib/server/core/rls.test.ts` (extend), under `soundboard_app` (Codex #1):**
    - positive: a user reads and writes only their own guides and claims
    - cross-artist, both tables: SELECT returns none of B's rows; INSERT for B's `artist_id` refused; UPDATE and DELETE of B's rows change 0 rows
    - expiry boundary (Codex #5): a proposal at `now() - 29 days + 1 minute` is visible; at `now() - 29 days` it's invisible and approving it fails
    - a direct app `INSERT` of a `proposed` row refused; an approved insert with `proposed_at` in the future refused
    - `CHECK` bypasses refused (Codex #4): approved `{"videoId":"x"}`; approved with an extra `videoId` key; a null field; a missing field; a string count; a non-object; proposed missing `drafts`
    - an app `DELETE` of an approved row changes 0 rows
    - `soundboard_save_proposal`:
      - inserts for the caller's artist with `proposed_at` equal to the claim's `claimed_at`
      - replaces a fresh and an expired (seeded 30 days back) proposal with a new `id`, and releases the claim
      - `42501` with no identity or no profile; `55000` with a wrong or expired token; never touches the approved row
      - with uploads and no `connected` connection row → `28000`, nothing stored; edits-only (`uploads: []`, `drafts: []`) saves without one
    - cleanup role: sees and deletes only proposals at or past 29 days; never an approved row or a fresh proposal; can't read `body` or `sources`
- [x] T008 [P] Shared types in `src/lib/brand.ts` (data-model, inventory #11):
  - `VoiceRules`, `VOICE_RULES_MAX = 12`, `VOICE_RULE_MAX = 240`, `VOICE_UPLOADS = 30` (or T004's lower value).
  - `voiceError(voice)` with exactly: "Add at least one voice rule.", "Voice has more than 12 rules.", "A voice rule is over 240 characters."
  - `GuideKind`, `UploadSource`, `ProposalSources`, `SourceSummary`, `Proposal<B>`, `Approved<B>`, `GuideState<B>` (with `limitUntil`). Delete `StoredBrand`.
  - Tests in `tests/unit/lib/brand.test.ts`: 0, 1, 12 and 13 rules; 240 vs 241 characters; whitespace-only rules split away.
- [x] T009 Create `src/lib/server/artist/guides.ts` (data-model, research R8, R9, R10, inventory #5):
  - `getGuides(artistId)` (with each kind's future `limit_until`), `approvedGuides(artistId)` (one query), `claimProposal(artistId, kind)`, `releaseProposal(artistId, kind, token, limitUntil?)`, `saveProposal(kind, body, sources, token)` (calls `soundboard_save_proposal`), `approveGuide(artistId, kind, proposalId, body)`, `discardProposal(artistId, kind, proposalId)`, `dropProposals(tx)`.
  - **Claim:** the data-model insert-once, then the conditional `UPDATE … RETURNING`. No row back → `{ wait: 'model quota spent', limitUntil }` when `limit_until` is in the future, else `ActionError(409, 'A proposal is already running in another tab.')`.
  - **Release:** only by matching token; optional `limit_until`.
  - **Approve/discard:** one transaction; `SELECT … FOR UPDATE` the pending row; missing, expired, foreign or other `id` → `ActionError(404, 'The guide changed in another tab. Reload to see it.')`. Approve upserts the approved row with `ON CONFLICT (artist_id, kind, status) DO UPDATE SET body, sources, proposed_at, approved_at` (those four only) and `sources` collapsed to `{ uploads: <length>, drafts: <length>, edits, approvals, carriedOver: false }`, then deletes the proposal.
  - Tests in `tests/unit/lib/server/artist/guides.test.ts`:
    - propose → approve → active; propose twice → one pending row with a new `id`, `proposed_at` from the claim, and an approve naming the old `id` → 404
    - approve then approve the same `id` → 404; approve then discard → 404; discard then approve → 404
    - expired proposal (seeded 29 days back) → 404
    - another artist's `proposalId` → 404 with the same message, their rows unchanged
    - approval keeps an extra column untouched: in the test, `ALTER TABLE artist_guides ADD COLUMN probe text` on the PGlite instance, set it on the approved row, re-approve, assert it's unchanged (R10)
    - approved `sources` has counts only, `drafts` counted
    - claims (Codex #8): a second claim while held → 409; release with a wrong token changes nothing and the slot stays held; release with the right token frees it; an expired claim (`claim_until` in the past) is taken by a new token, and the old token can neither save nor release
    - quota (Codex #10): release with `limitUntil` → the next claim returns the wait with that `limitUntil`; after it passes, a claim succeeds; `getGuides` returns the future `limitUntil` and drops a past one
- [x] T010 [P] Retention job (research R4, inventory #9):
  - `src/lib/server/core/genre-cleanup.ts`: add `DELETE_EXPIRED_PROPOSALS = "delete from artist_guides where status = 'proposed' and proposed_at <= now() - interval '29 days' returning id"`; `handleGenreCleanup` runs it after the evidence delete and answers `{ deleted, proposals }`. Either failing → 500, as today.
  - `functions/genrecleanup.ts` needs no change beyond the import; confirm.
  - Extend `tests/unit/lib/server/core/genre-cleanup.test.ts`: both counts; a proposal at 29 days minus one minute, fresh proposals and approved rows survive; one at 29 days is deleted; a failing second statement → 500.
- [x] T011 [P] Agent `voice-guide` and guide redaction (research R4, R5, inventory #10). Needs T004.
  - `src/lib/server/core/tracing.ts` `AgentName` gains `'voice-guide'`. `src/lib/server/ai/model.ts` `AGENTS['voice-guide'] = { model: pickModel, thinkingLevel: 'medium', maxTokens: 8192, minCallMs: <T004's value> }`.
  - **Redaction (Codex #3):** `AGENTS[agent].redactReply` is `true` for `voice-guide` and `brand-guide`.
    - `chat` passes it to `chatSpan`, which records the text and reasoning parts as `[guide proposal: <n> chars]` (n = that part's length).
    - `agentOutput` gets the same placeholder from its caller.
    - `chatJson`'s re-ask resends the failed reply as a text part tagged `source: 'guide'`, and `redactTurns` maps it to `[guide proposal: <n> chars]`. `sdkMessage` drops `source`, as for `youtube`.
  - Extend `tests/unit/lib/server/ai/model.test.ts` and `tests/unit/lib/server/core/tracing.test.ts`:
    - the call sends `thinkingLevel: 'medium'`, `store: false`, no `mediaResolution`
    - **sentinels:** a faked Gemini reply and reasoning containing `SENTINEL-GUIDE-7f3`:
      - success: no `invoke_agent` or `chat` span attribute in the Sentry mock contains it, and the placeholders show the right lengths
      - malformed then valid: the re-ask's input and both `chat` outputs contain no sentinel; the model still receives the real resent text
    - `smart-pick` and `hook-pick` replies are still recorded verbatim
- [x] T012 Remove `curated` (research R2, R11, inventory #7, #17):
  - `src/lib/server/artist/profile.ts`: `ArtistProfile` drops `curated`.
  - `src/routes/+layout.server.ts`: layout `artist` drops `curated`.
  - `src/routes/+layout.svelte`: the menu link reads "Brand" and shows for every user with `data.artist`.
  - Replace 004's `requireCurated` with `requireArtist(user)` in `src/lib/server/artist/profile.ts` (a profile gate shared by brand and voice routes): `error(404, 'Not found')` unless `user?.artist`. Tests in `tests/unit/lib/server/artist/profile.test.ts`.
  - Update `tests/unit/routes/layout.test.ts`, `layout.server.test.ts`, `tests/unit/lib/server/auth/users.test.ts`, and the profile tests.
- [x] T013 Brand storage on `artist_guides`, the new routes, and disconnect cleanup (research R4, R6, R8, R11, contract, inventory #3, #12–#14, #22):
  - **`src/lib/server/artist/brand.ts`:**
    - Delete the `artist_memory` slots, `getBrand`, `approvedBrand`, `approveBrand`, `discardBrandProposal`.
    - `proposeBrand(user)` keeps its prompt, limits and cleaning:
      - `stepDeadline()` at entry, then `claimProposal`; release in `finally`
      - 004's `accessTokenFor(uid, channelId, deadline)` → `ownUploads(token, channelId, BRAND_VIDEOS, deadline)` through the caller's grant; `thumbnailImage` gets the same deadline
      - `hasModelTime('brand-guide', deadline)` false → `{ wait: 'model busy' }`
      - `saveProposal` with `sources = { uploads: [{ videoId, title, publishedAt }], drafts: [], edits: 0, approvals: 0, thin: false }`
    - **Grant, per research R8 through `identityFailure` (Codex #6):**
      - no connection, `no_channel`, `revoked`, `missing_scopes`, null token → `{ wait: 'reconnect YouTube' }` before any read
      - `access-lost` → `access.refused` (tagged with the guide kind), then the reconnect wait
      - `busy` → `{ wait: 'waiting on YouTube' }`, grant untouched
      - `app-rejected` → error
      - a save refused with `28000` → reconnect wait
      - 004's `409 "Connect YouTube to read your channel."` is removed if 004 kept it
    - **Quota:** `ModelQuotaSpent` → `releaseProposal(…, error.until)` and `{ wait: 'model quota spent', limitUntil: error.until }`.
    - 004's `uploadCount` on proposals is replaced by `sources`. Sentry: the uploads part stays tagged `source: 'youtube'` (004); the reply is redacted by T011.
  - **`src/lib/server/platforms/youtube/connection.ts` (Codex #2):** `revokeGrant` and `markRevoked` call `dropProposals(tx)` in the same transaction, after the connection write.
  - `src/params.ts`: the `guide` matcher (SvelteKit 3 `defineParams`), `brand` only for now (US1 adds `voice`).
  - `src/routes/api/guides/[kind=guide]/{propose,approve,discard}/+server.ts`: `requireArtist`, then dispatch by `kind`. Approve body `{ proposalId, statement, keep, fix, drop }` validated by `isBrandGuide` + `guideError`; discard body `{ proposalId }`. Status codes and messages exactly as the contract.
  - Delete `src/routes/api/brand/` and its tests in `tests/unit/routes/api/brand/`.
  - `src/lib/api.ts`: `proposeGuide(kind)`, `approveGuide(kind, body, proposalId)`, `discardGuide(kind, proposalId)`; delete the three brand functions.
  - `src/routes/brand/+page.server.ts` returns `getGuides(locals.user.artist.id)`, shaped `{ voice: GuideState<VoiceRules>, brand: GuideState<BrandGuide> }`. `src/routes/brand/+page.svelte` keeps today's brand form on the new shapes (the voice section comes in US1).
  - **Tests:** rewrite `tests/unit/lib/server/artist/brand.test.ts`:
    - sources stored with titles; bearer is the caller's; no `statistics` part
    - by reason (Codex #6): 403 `quotaExceeded` and 403 `rateLimitExceeded` → `waiting on YouTube`, connection still `connected`; 403 `insufficientPermissions` and 401 → `reconnect YouTube`, connection marked refused; 403 `accessNotConfigured` → error, connection untouched
    - never connected → reconnect wait with 0 YouTube and 0 Gemini calls; zero uploads 409
    - busy 429 stores nothing; a slow read that spends the budget → `model busy`, 0 Gemini calls
    - quota: `{ wait, limitUntil }`; a second propose before the reset makes 0 YouTube and 0 Gemini calls (Codex #10)
    - a concurrent second propose while the first holds the claim → 409
    - deadline passed to YouTube and thumbnail fetches
    - Sentry span input holds no upload title or description; reply sentinels per T011
  - **Tests:** `tests/unit/lib/server/platforms/youtube/connection.test.ts`:
    - disconnect deletes both kinds of proposal and keeps approved rows
    - `markRevoked` does the same
    - **disconnect during generation:** the faked Gemini call runs `revokeGrant` before replying. The save is refused, the step returns `reconnect YouTube`, and no proposal row exists after.
  - **Tests:** `tests/unit/routes/api/guides/{propose,approve,discard}/server.test.ts` (401 signed out, 404 no profile, 404 unknown kind, 400/422/404/409/200 per the contract).
- [x] T014 Picks and hooks read the approved guides (research R7, inventory #1, #2, #23):
  - `src/lib/server/ai/smart-pick.ts`:
    - delete `ARTIST_VOICE` and 004's curated credit block; `PickContext.artist` = `{ name; contactLine }`; add `voice: VoiceRules | null`
    - `voiceBlock(voice)`: approved → `"Write the description the way the artist writes their own:"` then `- <rule>` per rule; null → `GENERIC_VOICE`
    - right after the voice block, every run: `"These content rules outrank the voice rules: hashtags and tags only from candidateLists, no loudness, peak, clipping or silence figures except ffmpeg's, YouTube length limits, and facts, credits and links only from artistNotes, facts and recentUploads. Never write placeholders."`
    - credit lines (research R7): approved voice → "Write a credit line only as the voice rules say, with the credited name exactly as in recentUploads" and `bandcamp.credits` from the description; no approved voice → 004's "Write no credit line" and `''`. 004's contact stripping and app-placed contact line are unchanged
  - `src/lib/server/pipeline/short.ts` (Codex #7): `HookContext.voice`; with a voice, `buildHookRequest` adds "Write reason the way the artist writes their own:" with the rules after the hook's rules, then "The rules above outrank the voice rules."; null → today's prompt.
  - `src/lib/server/pipeline/pipeline.ts` `pick()` and the hook step: when `artistJob(job)`, `approvedGuides(job.artistId)` gives `voice` (and `brand` for the pick); otherwise `voice: null`, `brand: null`. Same deadline; no extra YouTube call.
  - Tests in `tests/unit/lib/server/ai/smart-pick.test.ts`, `tests/unit/lib/server/pipeline/short.test.ts` and `tests/unit/lib/server/pipeline/pipeline.test.ts`. Nathan's voice comes from the shared seed (T015), reseeded by `truncate()`:
    - **Nathan (SC-003):** his prompt contains each of `NATHAN_VOICE_RULES` in order, and no `GENERIC_VOICE` text; the brand block equals his seeded approved guide
    - user C with no approved voice → `GENERIC_VOICE`, no Nathan rule text, no brand block (FR-006)
    - user C with an approved voice → exactly C's rules; none of Nathan's (SC-002)
    - the content-rules line follows the voice block on every run (FR-008)
    - **numbers (Codex #11):** with Nathan's voice and notes giving "track 3 on the album Example", a faked reply keeping "is track 3 on the album Example." survives `finalizePick`; a faked "-14 LUFS" or "peaks at -1 dB" in the description is stripped
    - a job whose `artistId` differs from the owner's current link → no guides read
    - **FR-011, SC-006 (Codex #12):** jobs in `REVIEW`, `PUBLISHING`, `CLAIMED_COMPLETE` and `VERIFIED` with stored `picks` and `finalFields`. Snapshot their `picks` and `data` columns, run `approveGuide('voice', …)` and then `approveGuide('brand', …)`, and assert both byte-identical after each.
    - **hook (Codex #7):** with C's approved voice, `buildHookRequest` carries C's rules after the hook's rules and the outrank line; with none, the prompt equals today's
    - **Short across a guide change (Codex #7):** approve voice v1, approve a parent pick, approve voice v2, `createShort`. The Short's copied title, description and tags equal the parent's `finalFields`, and its hook request carries v2's rules, not v1's.
- [x] T015 Fixtures (Codex #13):
  - `tests/helpers/pipeline.ts`:
    - `NATHAN_VOICE_RULES`: the 9 golden lines (the 8 `ARTIST_VOICE` rules and the credit rule), copied from `smart-pick.ts` before T014 deletes it
    - `NATHAN_VOICE_RULES` lives in `tests/helpers/voice.ts` (no database import) and is re-exported here
    - the shared `USERS` seed carries Nathan's approved voice (`NATHAN_VOICE_RULES`, `carriedOver: true`) for `flr`, so every `truncate()` reseed has it
    - `approvedGuide(artistId, kind, body, sources?)` and `pendingProposal(artistId, kind, body, { sources, proposedAt, grantAt })`
  - `tests/e2e/fakes/fixtures.ts`:
    - seed Nathan's approved voice and brand guide explicitly, with upserts on `(artist_id, kind, status)`, since a fresh E2E database has no brand row for the migration to copy
    - user C has no guides and is read-only in E2E
    - for the tests that write (T020 approve, T027 race): per-project users `uid-b-<device>` and `uid-rc-<device>` (profiles `artist-b<d>` / `artist-rc<d>`), each with one seeded pending voice proposal. `tests/e2e/session.ts` picks the user by `testInfo.project.name`, as 004 does.
    - for the tests that propose (T020, T023): per-project users `uid-p-<device>` (profile `artist-p<d>`) with a connection to `UCtest`, so the two projects never share a claim
  - `tests/e2e/fakes/youtube.ts`: the owner-grant upload reads answer for user C's channel `UCtest` with 3 uploads with prose descriptions, so voice and brand proposals reach the model call (which the Gemini preload answers 429).

- [x] T035 Definer-function hardening (Codex final #1). Part of T005 and T007:
  - `soundboard_save_proposal` and `soundboard_claim_proposal` use `SET search_path = pg_catalog, public, pg_temp` (`pg_temp` last) and qualify every relation with `public.`.
  - Test in `rls.test.ts`: under `soundboard_app`, a `CREATE TEMP TABLE connections (…)` holding a `connected` row and a temp `guide_claims` holding a fresh claim change nothing: a save with uploads while the real connection is gone still raises `28000`, and a save on a token only the temp table holds raises `55000`.
- [x] T036 Database-controlled claim times (Codex final #2). Part of T005, T007 and T009:
  - The claim runs through `public.soundboard_claim_proposal(p_kind, p_token)`, which sets `claimed_at = now()`, `claim_until = now() + 3 minutes` and the connection generation itself. `soundboard_app` gets `SELECT` and `UPDATE (claim_token, claim_until, limit_until)` on `guide_claims` only: no `INSERT`, no write to `claimed_at` or `grant_at`.
  - `soundboard_save_proposal` refuses (`55000`) a claim whose `claimed_at` is in the future or more than 3 minutes old, whatever `claim_until` says.
  - Tests: an app `UPDATE guide_claims SET claimed_at = …` is denied (`42501`); a claim row a privileged write moved 365 days ahead, or 4 minutes back, can't be saved through the function; a direct `INSERT` is denied.
- [x] T037 Connection-generation binding (Codex final #3). Part of T005, T009, T013 and T016:
  - The generation is `connections.updated_at` of the `connected` row: every new grant writes it, and nothing else changes a connected row. It isn't secret.
  - The claim copies it into `guide_claims.grant_at` (null when not connected). The save requires, when the proposal lists uploads or drafts, a `connected` row with `updated_at = grant_at` (`FOR SHARE`), else `28000`; it stores `grant_at` on the proposal.
  - `revokeGrant` and `markRevoked` delete only proposals whose `grant_at` is the revoked grant's generation, in the same transaction as the connection write; `markRevoked` takes the connection it refused (`{ tokenCiphertext, updatedAt }`).
  - Tests: claim → read → disconnect → reconnect → save is refused with `reconnect YouTube` and stores nothing (reconnect-before-save); a proposal saved on the new grant survives a stale `markRevoked` / `revokeGrant` of the old one (stale-revocation-after-reconnect), and a proposal of the old grant is deleted by it.

**Checkpoint**: `make ai-checks` green. Nathan's picks unchanged (T014 golden test, T007 migration replay). Brand page works on the new table.

---

## Phase 3: User Story 1 — Propose and approve my voice (P1) 🎯 MVP

**Goal**: an artist proposes a voice from their own descriptions, approved Soundboard drafts and Soundboard edits, edits it, approves it, and their next pick follows it.

**Independent Test**: as user C (unit, Gemini and YouTube `fetch` faked): propose → sources list C's uploads, drafts and edit counts → edit one rule → approve → the next pick's prompt carries exactly C's rules.

- [x] T016 [US1] Create `src/lib/server/artist/voice.ts` (research R5, R8, inventory #4). Needs T004.
  - **`voiceEvidence(artistId, uploads)`:**
    - split uploads by the artist's `publish` memory keys into `written` and `drafts` (Q3); clip descriptions to 1,500 characters
    - `recentFeedback(artistId, 60)` → EDITED `title`/`description` rows (before/after clipped to 600) and ACCEPTED rows (final title only); SKIPPED and tag edits dropped
    - `thin = writtenProse + strongEdits < 5`, prose = ≥ 15 words after removing URLs and `#hashtags`; drafts don't count
  - **Request:** `VOICE_SCHEMA` `{ rules: string[] }`, `isVoiceRules`, `buildVoiceRequest(evidence)` with the R5 system rules verbatim and the 3-rule cap when thin. Two upload text parts, each tagged `source: 'youtube'`: "Written by the artist" first, then "Approved Soundboard drafts (lower weight)". Edits in their own untagged part. `cleanVoice` (`stripDeep`, trim, case-insensitive dedupe, cap 12 × 240).
  - **`proposeVoice(user)`:**
    - `stepDeadline()` at entry, then `claimProposal`; release in `finally`
    - `accessTokenFor(uid, channelId, deadline)` → `ownUploads(token, channelId, VOICE_UPLOADS, deadline)`
    - grant handling as T013 (never connected or `no_channel` → edits only)
    - no usable uploads of either kind and no EDITED rows → `409 "Nothing to learn from yet. Connect YouTube or finish a few releases first."` before any model call
    - `hasModelTime('voice-guide', deadline)` false → `{ wait: 'model busy' }`
    - `invokeAgent('voice-guide', …)` with `chatJson` and the shared deadline
    - waits: busy → `{ wait }`; quota → release with `limitUntil`, `{ wait, limitUntil }`
    - unparsed → `502 "The model reply did not parse as a voice."`
    - else `saveProposal` with `{ uploads, drafts, edits, approvals, thin }` (each upload `{videoId, title, publishedAt}`); `28000` → reconnect wait
  - **Sentry:** upload parts show `[YouTube uploads: <n>]`; edits stay; reply and reasoning redacted by T011.
  - Tests in `tests/unit/lib/server/artist/voice.test.ts`:
    - positive: request carries C's descriptions and edits; stored proposal lists the uploads read and the counts
    - drafts (Q3): a Soundboard-published video appears under "Approved Soundboard drafts (lower weight)", after "Written by the artist", and in `sources.drafts`, not `sources.uploads`; it doesn't count toward `thin`; only drafts and no edits still proposes
    - SKIPPED rows and tag edits excluded
    - thin evidence: `thin: true` and the prompt's 3-rule cap
    - US1 AS4: no channel and no edits → 409, 0 Gemini and 0 YouTube calls
    - edits only, never connected → proposal with `uploads: []` and `drafts: []`
    - grant by reason, as T013: quota and rate 403 → YouTube wait, grant untouched; `insufficientPermissions` → reconnect, grant refused, no proposal stored, approved voice untouched; `accessNotConfigured` → error
    - busy 429 → wait, nothing stored; per-day 429 → `{ wait, limitUntil }`, and the next propose before the reset makes no provider call; unparsed twice → 502
    - a slow read leaving under `minCallMs` → `model busy`, 0 Gemini calls
    - no `statistics` in any `part`, no comment endpoint called (FR-003)
    - model-emitted audio figures stripped; 13 rules capped at 12
    - Sentry span input holds no description text, only `[YouTube uploads: <n>]`; reply and reasoning sentinels absent in every span, success and re-ask
    - a credited full name in a description (fixture name `Credit Person`) reaches the model request unchanged: nothing filters names from runtime data (spec edge case)
- [x] T017 [US1] Voice routes: the `guide` matcher in `src/params.ts` (SvelteKit 3 `defineParams`) accepts `voice`; the three handlers dispatch `voice` to `proposeVoice` / `approveGuide` with `isVoiceRules` + `voiceError` / `discardProposal`. Extend the three route tests: voice 200s, 400 `"Expected voice rules."`, 422 per `voiceError`, 404 race and foreign ID, 409 claim held, 404 no profile.
- [x] T018 [P] [US1] Shared propose loop `src/lib/propose.ts`: `proposeUntilReady(kind, onWait, stopped)` with `pRetry` + `POLL_BACKOFF`, retrying only `model busy` and `waiting on YouTube`; `model quota spent` and `reconnect YouTube` abort with their `WAIT_TEXT`. Tests in `tests/unit/lib/propose.test.ts`: busy then success; YouTube busy then success; quota stops and passes `limitUntil` on; reconnect stops; stop flag aborts; a thrown 409 or 404 surfaces its message.
- [x] T019 [US1] `src/lib/components/VoiceGuide.svelte` and the Voice section of `src/routes/brand/+page.svelte` (contract):
  - Approved: rules list; "Carried over from your earlier rules" when `carriedOver`, else "From N uploads, D Soundboard drafts, M edits and K approvals, proposed <date>"; none → "Not set. Drafts use plain, generic rules."
  - Proposal:
    - source list in two groups, "Written by you" and "Approved Soundboard drafts": title + date, linked to `https://www.youtube.com/watch?v=<id>`, `target=_blank rel="noopener noreferrer"`
    - edit and approval counts, and "Little writing to learn from: N descriptions, M edits." when `thin`
    - one textarea, one rule per line
    - Approve and Discard, disabled while busy or when `voiceError` returns a message
  - A future `limitUntil` on load shows the quota wait text on the Propose button.
  - On a 404 the message shows and the textarea keeps its text.
  - Page `<title>`: "Brand · Soundboard"; `<h1>` "Brand".
  - Tests in `tests/unit/lib/components/VoiceGuide.test.ts` and `tests/unit/routes/brand/page.test.ts`.
- [x] T020 [US1] E2E `tests/e2e/brand.spec.ts`, voice (both projects):
  - C opens `/brand` from the menu "Brand": Voice reads "Not set. Drafts use plain, generic rules."
  - Propose → `{ wait: 'model busy' }` from the 429 preload, the button shows the wait text, nothing stored.
  - As the per-project `brand-*` user (T015), with its seeded proposal: edit a rule, approve → the approved list shows it with counts.
  - B (no profile) → `/brand` 404 and `POST /api/guides/voice/propose` 404.

**Checkpoint**: US1 independently testable. Non-Nathan drafts follow their own approved voice.

---

## Phase 4: User Story 2 — Propose and approve my brand guide (P1)

**Goal**: every artist proposes, edits and approves their own brand guide, read through their own grant; picks follow it.

**Independent Test**: as C: propose brand (faked) → sources list C's uploads → approve → the next pick's prompt has C's brand block. Another user sees only their own.

- [x] T021 [US2] `src/lib/components/BrandGuide.svelte` and the Brand guide section of `src/routes/brand/+page.svelte`: today's statement and keep / fix / drop editor moved into the component on the `Proposal`/`Approved` shapes, using `src/lib/propose.ts`, with its upload list. None approved: "Not set. Drafts run without one." 404 keeps the text. Update the help line to name the owner's own uploads. Tests in `tests/unit/lib/components/BrandGuide.test.ts` and `tests/unit/routes/brand/page.test.ts`.
- [x] T022 [US2] Isolation and use (FR-007, FR-010, US2 AS2–AS3), in `tests/unit/lib/server/artist/guides.test.ts` and `tests/unit/lib/server/pipeline/pipeline.test.ts`:
  - with A (Nathan, seeded voice plus `approvedGuide`) and C both approved, A's pick carries only A's brand and C's only C's
  - C's `getGuides` never returns A's rows; a C session approving A's `proposalId` → 404 and A unchanged
  - a re-run pick reads the current approved guide; a Short's hook pick reads the current approved voice
- [x] T023 [US2] E2E `tests/e2e/brand.spec.ts`, brand (both projects):
  - C's Brand guide reads "Not set. Drafts run without one."; Propose reaches `model busy`
  - A sees his own approved guide (seeded by T015), and C's page shows none of A's statement text (SC-002)
  - signed out: `/brand` → 303 home; `POST /api/guides/brand/propose` → 401

**Checkpoint**: US1 and US2 deliver the MVP for every non-Nathan artist.

---

## Phase 5: User Story 3 — Nathan keeps what he has (P1)

**Goal**: Nathan's voice and brand guide show approved with today's content; a later proposal replaces his only after approval.

**Independent Test**: A's `/brand` shows both approved, "Carried over", and his pick prompt matches the golden rules (T014); the migration produces those rules (T007).

- [x] T024 [US3] Replacement only on approval (US3 AS2), in `tests/unit/lib/server/artist/voice.test.ts`, on the shared seed: as A, propose a new voice (faked) → `approvedGuides('flr')` still returns `NATHAN_VOICE_RULES`; discard → unchanged; propose and approve → the new rules, `carriedOver: false`.
- [x] T025 [US3] E2E `tests/e2e/brand.spec.ts`, Nathan: A opens `/brand` and sees Voice and Brand guide approved (seeded by T015), the voice marked "Carried over from your earlier rules", and his first carried rule text ("Short, plain, literal.").

**Checkpoint**: Nathan's release flow unchanged; his guides visible and editable.

---

## Phase 6: User Story 4 — The voice stays current (P2)

**Goal**: new edits feed the next proposal; the active voice changes only on approval.

**Independent Test**: approve a voice for C, add EDITED feedback, propose again: the request carries the new edits, `approvedGuides` is unchanged until approval.

- [x] T026 [US4] In `tests/unit/lib/server/artist/voice.test.ts`:
  - after approval, 3 new EDITED rows → the next request's edits include them, newest first
  - pending proposal + the active voice → the pick uses the active voice (US4 AS1)
  - discard → active unchanged (US4 AS2)
  - a Short approval's EDITED rows count as evidence; no ACCEPTED row is written for it (AGENTS.md)
- [x] T027 [US4] Race in the UI (spec edge case): `tests/e2e/brand.spec.ts`, two pages for the per-project `race-*` user (T015) on its seeded proposal: approve in page 1, approve in page 2 → "The guide changed in another tab. Reload to see it.", page 2's textarea still holds its edit, and a reload shows page 1's approved rules.

**Checkpoint**: all four stories independently testable.

---

## Phase 7: Polish and validation

- [x] T028 [P] Docs (inventory #18, #21):
  - `docs/operations/youtube-retention.md`:
    - the daily job also deletes voice and brand proposals 29 days after their claim, so none outlives 30 days
    - the response reports `proposals`; `soundboard_cleanup` sees only `(id, status, proposed_at)` of expired proposals
    - deploy order: the cleanup redeploy goes out before, or with, the app revision that serves proposals
    - a missed daily run breaks the 30-day bound
  - `docs/youtube-audit/architecture.md`: proposals read the artist's own uploads through their grant, are hidden at 29 days and deleted daily, and are deleted on disconnect; approved rules are kept as the artist's own statement (owner's III.E.4.h interpretation) with counts only; guide replies are redacted in Sentry.
  - `README.md` brand section: every artist proposes and approves a voice and a brand guide on `/brand`.
  - `src/routes/privacy/+page.svelte`: each artist profile stores voice and brand proposals (with the uploads they read, deleted within 30 days or on disconnect) and the approved rules. Update its test if one asserts the text.
- [x] T029 Sweep: `grep -rnE "ARTIST_VOICE|curated|StoredBrand|uploadCount|/api/brand|requireCurated|kind: 'brand'" src scripts functions` returns nothing. Migrations and tests may keep historic text. Record the output in the PR description.
- [x] T030 Validation loop (brief; max 5 attempts, then stop with the exact errors):
  1. `make ai-checks`: coverage ≥ 85/85/85/80, zero warnings
  2. `pnpm exec playwright test`: both projects
  3. `semgrep scan --config auto --error --metrics=off` on changed files: zero findings
  4. SonarQube `analyze_code_snippet` on each changed or added source file (`anchildress1_soundboard`): zero issues
  5. `pnpm audit --prod` and `pnpm audit`: zero
- [x] T031 👤 Live local validation, [quickstart Q4](quickstart.md#q4--live-local-validation-us1-us2-gemini-share--040). Gemini share ≤ $0.40, including T004.
  - Read `/private/tmp/claude-501/-Users-anchildress1-git-personal-soundboard/62e697ca-854d-4335-b7d9-d69a103885aa/scratchpad/gemini-ledger.md` before each call; log each call.
  - Dev Neon branch only; a non-Nathan seeded user with a saved profile and a connected test channel (confirm it isn't Flies Like Robots).
  - One voice proposal and one brand proposal: approve both after an edit. Record SC-001 time and the `voice-guide` latency against T004's `minCallMs`.
  - Two-tab race and disconnected brand proposal (reconnect wait) per Q4.
  - Optional single pick on the shortest `$HOME/Downloads/*.mp4` only if the ledger has room. No approval, no upload.
  - Report calls, tokens, spend.
- [ ] T032 👤 Deploy order (operator authorization, deployment freeze): redeploy `genrecleanup` per `docs/operations/youtube-retention.md` before, or with, the first app deploy that serves `/api/guides/*/propose`, and confirm one scheduled run reports `proposals` (quickstart Q5).
- [x] T033 After the rebase onto 004's merged code (and 003 if it lands a migration): if the migration number moved, delete this migration, its snapshot and journal entry, rerun `pnpm drizzle-kit generate --name artist_guides`, and paste the T005 data block, grants and function back. Rerun T007 and T030.
- [ ] T034 👤 Post-release: quickstart Q6 blind comparison with an artist (SC-005). Not a merge gate.

---

## Dependencies and execution order

- **Setup (T001–T004)** first. T001 is the PR's first commit; T002 and T003 run in parallel after it. T004 runs at implementation start and blocks T011 and T016.
- **Foundational (T005–T015, T035–T037)** blocks every story and lands green as a group. T035–T037 fold the Codex final-pass findings into T005, T007, T009, T013 and T016:
  - T005 → T006 → T007.
  - T008, T010, T011 [P] beside T005 (T011 after T004).
  - T009 needs T005, T006, T008.
  - T012 needs T005.
  - T013 needs T009, T011 and T012.
  - T014 needs T009, T012 and T015's helpers.
  - T015 after T006, before T014 deletes `ARTIST_VOICE`; its E2E parts before T020.
- **US1 (T016–T020):** T016 → T017; T018 [P] beside T016; T019 needs T017 and T018; T020 last.
- **US2 (T021–T023):** after T013 and T018. Independent of US1 except the shared page file (`+page.svelte`): do T019 and T021 in sequence, not in parallel.
- **US3 (T024–T025):** after T016 (T024) and T019 (T025).
- **US4 (T026–T027):** after T016, T017 and T019.
- **Polish (T028–T034):** T028 [P] anytime after T013. T029 after every story. T030 after T029. T031 after T030. T032 at the first deploy. T033 at rebase. T034 after release.

## Parallel examples

- **Foundational:** T008 (`src/lib/brand.ts`), T010 (`genre-cleanup.ts`) and T011 (`model.ts`, `tracing.ts`) beside T005.
- **US1:** T018 (`src/lib/propose.ts`) beside T016 (`voice.ts`).
- **Polish:** T028 docs beside any story phase.

## Implementation strategy

- **MVP:** Phases 1–4. Every artist proposes and approves both a voice and a brand guide, and Nathan's drafts are unchanged from the Foundational checkpoint on.
- **Then** US3's checks and US4's evidence and race coverage.
- **One PR** on `005-artist-branding`, stacked on `004-artist-profile`. Commits per task group, signed and atomic; T001 first.

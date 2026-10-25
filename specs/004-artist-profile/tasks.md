---
description: 'Task list for artist profile inputs and display'
---

# Tasks: Artist profile inputs and display

**Input**: Design documents from `specs/004-artist-profile/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/artist-profile.md](contracts/artist-profile.md), [quickstart.md](quickstart.md)

**Tests**: Required. AGENTS.md and constitution V require positive, negative, error and edge-case tests for every new module.

- Unit tests go in `tests/unit/`, mirroring `src/`. E2E tests go in `tests/e2e/`.
- Import app code through `#lib/*` and `#src/*`, with `.js` extensions.
- Mock only at process boundaries: YouTube, Google OAuth and Gemini HTTP via `fetch`, KMS, ffmpeg. The database is PGlite with real migrations, and Sentry is the global mock.
- Each task's tests are part of that task.

**Inventory**: the `#n` numbers point at the [plan's hard-coded inventory](plan.md#hard-coded-inventory). Every entry is closed by some task below.

**Organization**: tasks are grouped by user story. US1 and US2 are P1; US3 and US4 are P2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story the task serves (US1–US4)
- 👤 Yours to run or approve. For repo config files, I draft the diff and you OK it before anything changes.

---

## Phase 0: Constitution gate

- [x] T000 👤 Decision gate (research R0), decided 2026-10-25:
  - III wins: a missing or revoked grant waits. The spec was changed to match.
  - II (grounded voice) and IV (no artist constants) get explicit, temporary exceptions, removed by spec 005.
  - II (tags from candidates) gets the permanent required-artist-tag exception PRD R4 already states.
  - Classification: **MAJOR, 2.0.1 → 3.0.0** (an exception redefines a MUST; precedent `cef38f2`).
- [x] T001 👤 Amend `.specify/memory/constitution.md` through `/speckit-constitution` (blocks T006 onward):
  - II: "Until spec 005 ships, artists without a curated profile get generic voice rules (`GENERIC_VOICE`)."
  - IV: "Until spec 005 ships, Nathan's `ARTIST_VOICE` and credit wording stay in `smart-pick.ts`, selected by `artists.curated`."
  - Each voice exception names spec 005 as its removal point.
  - II, tags (permanent): "The pick's own artist name (`Pick.artistName`) is the one tag allowed outside the candidate lists, exactly once."
  - Version 3.0.0, with the Sync Impact Report.

---

## Phase 1: Setup

**Purpose**: the docs agents work from. The constitution treats code that disagrees with the PRD as a stop, so these come first.

- [ ] T002 Update `docs/prd.md` (FR-016):
  - Header and Users (lines 5, 49): every user owns one artist profile, and Nathan's is Flies Like Robots.
  - Non-Goals (line 45): per-artist voice and brand come with spec 005.
  - R4 (lines 87, 99, 100, 103, 105):
    - Identity reads are the owner's 3 most recent uploads through the owner's grant, on every pick. A missing or revoked grant waits on "reconnect YouTube".
    - Nathan's voice applies to the curated profile; everyone else gets generic voice rules and no credit line.
    - Tags include the owner's artist name exactly once, recorded on the pick and fixed in the Review editor.
    - The app places the contact line at the end of the description body and the Bandcamp credits.
    - The Bandcamp editor is the owner's `https://<name>.bandcamp.com` plus `/edit_track`.
  - R5 (line 119): feedback goes to the owner's artist profile, which is `artist_memory` keyed by the profile.
  - R8: after first sign-in, the artist form appears before the first release.
  - R10 (lines 173, 178):
    - Every user has at most one profile, never shared.
    - The app claims a new profile only through `soundboard_create_artist`, and the artist link is otherwise operator-only.
  - R11 (line 187): YouTube-sourced text is replaced with `[YouTube uploads: <n>]` in spans.
  - R12 (line 194): reads the owner's uploads through their grant, only for the curated profile, and stores a count, not video IDs.
  - Postgres table (lines 237, 240): add the `artists` row, and drop the name seed from the `artist_memory` row.
  - UX (lines 254, 256, 258):
    - The header shows the artist name.
    - Brand guide appears only for the curated profile; Settings for everyone, with an Artist section.
    - The footer's artist credit only when signed in.
  - Keep line 273.
- [ ] T003 [P] Update `AGENTS.md` (FR-016):
  - Line 15: `ARTIST_VOICE` applies only to `artists.curated`; everyone else gets `GENERIC_VOICE`. Spec 005 removes `curated`.
  - Line 17: "Hashtags and tags: only from the job's candidate lists (PRD R4), plus the pick's own `artistName` tag exactly once. Reject anything else."
  - Lines 26-27:
    - Only a user with a curated profile opens `/brand`.
    - Gate artist memory and feedback on `artistJob`. Identity reads need the owner's profile and grant; without the grant, the pick waits on `reconnect YouTube`.
  - Line 38: add "Replace YouTube-sourced text parts (`source: 'youtube'`) with `[YouTube uploads: <n>]`."
  - Add: "Artist values come from `artists` only. NEVER add an FLR constant to app code."
  - Add: "NEVER store identity-read uploads (titles, descriptions, video IDs) in the database."
- [x] T004 👤 Gate G1, signed-out part: Bandcamp editor URL (constitution V, research R12, quickstart Q6). The signed-out redirect was verified 2026-10-25 for every accepted URL. The signed-in check is T043 (owner, non-blocking).
- [x] T005 👤 Gate G2: the deadline aborts a stalled token refresh (research R14, quickstart Q8). Passed 2026-10-25. Blocks T020.

---

## Phase 2: Foundational (blocks every story)

**Purpose**: schema, migration, profile access, shared types.

**⚠️ CRITICAL**: no user story work starts until this phase is green.

- [ ] T006 Schema and migration (data-model, research R1–R3, R16, inventory #50):
  - **`src/lib/server/core/schema.ts`:** add `artists` with exactly the data-model rules:
    - `id text PK`
    - `name text not null`, `CHECK name = btrim(name) and char_length(name) between 1 and 100 and name !~ '[<>,]' and name !~ '^#'`
    - `bandcamp_url text`, null or `~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?\.bandcamp\.com$'`
    - `contact_line text`, null or `= btrim(contact_line)`, `char_length between 1 and 200` and `!~ '[<>#]'`
    - `curated boolean not null default false`
    - `created_at`, `updated_at` (`timestamptz`, default `now()`)
    - RLS `artists_owner` for select and update to `soundboard_app`, using `id = (select u.artist_id from public.users u where u.uid = <principal> and u.active)`
  - **Other tables:**
    - `users.artist_id` → `.unique().references(() => artists.id)`
    - `jobs.artist_id` and `artist_memory.artist_id` → `references(() => artists.id)`
    - `jobs_insert` top-level branch → `parent_id is null and artist_id is not null and artist_id = (select u.artist_id …)`
  - **Generate:** `pnpm drizzle-kit generate --name artist_profiles`.
  - **Then, before committing,** edit the generated SQL in `drizzle/0005_artist_profiles.sql`:
    - Put the data-model data block (steps 1–5) after `CREATE TABLE "artists"` and before the first foreign key, unique constraint or policy statement.
    - Append `ALTER TABLE artists FORCE ROW LEVEL SECURITY`.
    - Append `GRANT SELECT, UPDATE (name, bandcamp_url, contact_line, updated_at) ON artists TO soundboard_app`.
    - Append `CREATE FUNCTION public.soundboard_create_artist(…)` exactly as data-model specifies, with `REVOKE ALL … FROM PUBLIC` and `GRANT EXECUTE … TO soundboard_app`.
  - Never write Nathan's surname or email login anywhere.
- [ ] T007 Update `tests/helpers/db.ts`:
  - `truncate()` includes `artists`.
  - `Seed` gains `artists` and inserts them before `users`.
- [ ] T008 Migration and RLS tests in `tests/unit/lib/server/core/rls.test.ts` (extend) and a new `tests/unit/drizzle/artist-profiles.test.ts`, on a fresh PGlite before `truncate`:
  - **Migration:** the `flr` row has the R3 values and `curated = true`. The facts are `home` and `mr-kill`, with no `artist-name`.
  - **Backfill:** in the test, on its own `new PGlite()`:
    1. Apply `drizzle/0000`–`0004` by splitting each file on `--> statement-breakpoint`, in `meta/_journal.json` order.
    2. Seed, privileged:
       - a `users` row with `artist_id = 'flr'`
       - an `flr` job with two picks, and a null-artist job with one pick
       - the stored `artist-name` fact for `flr`
       - an `flr` `brand` row with `basedOn: ['a', 'b', 'c']`
    3. Apply `0005`.
    4. Assert:
       - picks keep their order and gain `artistName` (`'Flies Like Robots'` / `null`), and nothing else
       - the brand row has `uploadCount: 3` and no `basedOn`
       - the stored `artist-name` fact is gone
       - the users link holds
  - **Fail loud:** the same harness with a `users` row linked to `'other'` makes `0005` fail (R3).
  - **RLS, positive:** a user reads and updates only their own `artists` row.
  - **RLS, negative:**
    - another user's row is invisible, and updating it changes 0 rows
    - no `UPDATE` of `curated` or `id` (permission denied)
    - no direct `INSERT` on `artists`
    - no `UPDATE users.artist_id`
  - **`soundboard_create_artist`:**
    - creates and links the profile
    - a second call raises `23505`
    - no identity raises `42501`
    - a `CHECK` violation raises: a 101-character name, `<`, a comma, a leading `#`, `https://example.com`, a contact line with `#`
  - **Constraints:** two users can't link the same profile (unique). A top-level job insert with `artist_id` null is rejected by `jobs_insert`.
- [ ] T009 [P] Create `src/lib/artist.ts`:
  - `parseArtist(input: unknown): { value: ArtistInput } | { errors: ArtistFieldErrors }`, implementing research R11 exactly, messages verbatim. The Bandcamp URL is stored normalized as `https://<sub>.bandcamp.com`.
  - Tests in `tests/unit/lib/artist.test.ts`:
    - valid input; empty optional fields → null
    - name: 100 vs 101 characters; `<`, `>`, a comma; a leading `#`; `#` inside the name accepted
    - Bandcamp: `https://Name.Bandcamp.com/` normalized; refused: `http:`, `javascript:`, `https://user:pw@x.bandcamp.com`, a port, a path, `https://bandcamp.com`, `https://x.bandcamp.com.evil.com`, a custom domain, an unparsable URL
    - contact: 200 vs 201 characters; `<`/`>`; `#` anywhere (`DM #myband`) → "Contact lines can't contain #."
    - surrounding whitespace; a non-object body
- [ ] T010 Create `src/lib/server/artist/profile.ts`:
  - `type ArtistProfile`
  - `artistProfile(uid, q?)`: joins `users` → `artists`, returns null with no link
  - `createArtist(value)`: calls `soundboard_create_artist`
  - `updateArtist(artistId, value)`: an RLS `UPDATE` that sets `updated_at`
  - `saveArtist(user, input)`: create-or-update with one `23505` retry, per the contract
  - Widen `ActionError.fields` in `src/lib/server/core/errors.ts` to `FieldErrors | ArtistFieldErrors`.
  - Tests in `tests/unit/lib/server/artist/profile.test.ts`:
    - create; update
    - concurrent create (the second call becomes an update)
    - another user's profile unreachable
    - invalid input leaving the old values
    - two users saving the same name both succeed (spec edge case)
- [ ] T011 Put the profile on the session (inventory #45-47):
  - `src/lib/server/auth/users.ts` `getUser` returns `artist: ArtistProfile | null`.
  - `src/hooks.server.ts:53-56` and `src/app.d.ts:5` replace `artistId` with `artist`.
  - `src/routes/+layout.server.ts:23` returns `artist: { name, bandcampUrl, curated } | null`.
  - Fix every `locals.user.artistId` reader the typecheck flags.
  - Update `tests/unit/lib/server/auth/users.test.ts`, `tests/unit/hooks.server.test.ts` and `tests/unit/routes/layout.server.test.ts`. Signed out must return `artist: null`, and the layout never returns `contactLine` or `id`.
- [ ] T012 [P] Shared types and fixtures:
  - **`src/lib/types.ts`:**
    - `Pick` gains `artistName: string | null`.
    - `Wait` gains `'Add your artist name first.'`.
  - **`src/lib/status.ts`:** `WAIT_TEXT` gets the same plain text.
  - **`tests/helpers/pipeline.ts`:**
    - `USER_A` stays linked to `flr` (curated) and connected to Nathan's fixture channel.
    - `USER_B` has no profile.
    - Add `USER_C`, linked to a non-Nathan profile: id `artist-c`, name `Test Artist`, `bandcampUrl` `https://test-artist.bandcamp.com`, `contactLine` `Booking: test@example.com`. C is connected to channel `UCtest`.
    - For E2E writes, one user per Playwright project:
      - `new-desktop@example.com` and `new-pixel@example.com`: no profile (US1)
      - `rename-desktop@example.com` and `rename-pixel@example.com`: profiles `artist-rd` and `artist-rp` (US4)
      - `tests/e2e/session.ts` picks the user by `testInfo.project.name`.
    - Seed the `artists` rows in `USERS`.
  - **`tests/e2e/fakes/fixtures.ts`:**
    - Mirror A, B and C, plus the per-project users.
    - The E2E database runs the real migrations, so `flr` already exists. Link A to it, and insert only C's and the per-project `artists` rows.
    - B has no profile. C owns its own job IDs per Playwright project, including a review job whose pick has `artistName: 'Test Artist'`.
  - Add `artistName` to every `Pick` fixture.
  - Existing unit tests that create top-level jobs as `USER_B` (through `create()` or request-scoped inserts) switch to `USER_C`, since `jobs_insert` now requires a profile (T006). Seeded privileged rows stay as they are.

**Checkpoint**: `make ai-checks` green on the foundation, before any story.

---

## Phase 3: User Story 1 — Tell Soundboard who the artist is (P1) 🎯 MVP

**Goal**: a user without a profile gets the form on `/new`, saves it, then sees the new-release form. Jobs can't start without a profile. Nathan never sees the form.

**Independent Test**: sign in as B and open `/new`: the form shows. An empty name is refused. Save a name: the new-release form appears, and the header shows the name.

- [ ] T013 [US1] Create `src/routes/api/artist/+server.ts` (`PUT`, per contract):
  - 401 signed out
  - 422 with `fields` and "Fix the highlighted fields."
  - 200 `{ artist }`; never `id` or `curated`
  - Add `saveArtist(body)` to `src/lib/api.ts`.
  - Tests in `tests/unit/routes/api/artist/server.test.ts`: 401, 422 per field, create, update, unchanged on 422, a body with `curated: true` or `id` ignored.
- [ ] T014 [P] [US1] Create `src/lib/components/ArtistForm.svelte`:
  - Props `initial`, `submitLabel`, `onsaved`.
  - Labelled inputs Artist name (required, `maxlength=100`), Bandcamp URL (`type=url`, placeholder `https://<name>.bandcamp.com`), Contact line (`maxlength=200`).
  - Always submits all three fields, pre-filled from `initial`.
  - Field errors from the 422 shown under each field. Plain labels only.
  - Tests in `tests/unit/lib/components/ArtistForm.test.ts`: renders `initial`, shows field errors, calls `onsaved` on 200, keeps the input on error, sends untouched optional fields with their initial values.
- [ ] T015 [US1] Gate `/new`:
  - `src/routes/new/+page.svelte` renders `ArtistForm` (heading "Who's the artist?", button "Save") when `data.artist` is null. On save it calls `invalidateAll()`, and then the existing form shows.
  - Keep the change to a wrapping `{#if}` (research R17).
  - Tests in `tests/unit/routes/new/page.test.ts`.
- [ ] T016 [US1] Refuse jobs without a profile (FR-003 AS4, research R16, inventory #43-44):
  - **`src/lib/server/jobs/create.ts`:** `409 "Add your artist name first."` before `signedUploadUrl` when `user.artist` is null, and `artistId: user.artist.id`.
  - **`src/routes/api/jobs/[id]/short/+server.ts`:** the same 409.
  - **Tests:** extend `tests/unit/lib/server/jobs/create.test.ts`, `tests/unit/routes/api/jobs/server.test.ts` and the short route test (409, no job row, no signing call; positive path stores `artist_id`).
- [ ] T017 [US1] Header name (FR-009, inventory #21): `src/routes/+layout.svelte` renders `data.artist.name` first in the header row, before the channel handle and counts, on its own row on phones like today. Extend `tests/unit/routes/layout.test.ts`.
- [ ] T018 [US1] E2E `tests/e2e/artist.spec.ts`, US1:
  - B on `/new` sees the form.
  - An empty name shows "Add the artist name.", and nothing is saved (reload still shows the form).
  - Saving `B Band` shows the new-release form and `B Band` in the header.
  - A (Nathan) on `/new` sees the new-release form directly.
  - B's `POST /api/jobs` before saving → 409.
  - B's existing job `e2e-b-review` still opens before a profile exists (spec edge case).
  - Runs on both Playwright projects. Each project uses its own invited no-profile user, since the test writes.

**Checkpoint**: US1 independently testable.

---

## Phase 4: User Story 2 — Drafts use the user's own artist details (P1)

**Goal**:

- Pick, re-run and Short use the owner's name as the required tag, and in every prompt that names the artist.
- The app places the owner's contact line, or none.
- Identity comes from the owner's channel through the owner's grant, inside the step deadline, or the pick waits.
- No FLR value reaches a non-Nathan draft, and no identity-read text is stored or traced.

**Independent Test**: unit pipeline run as C. Gemini and YouTube HTTP are faked.

- The prompt carries `Test Artist` and `GENERIC_VOICE`, and no FLR value or contact instruction.
- The stored pick has the `Test Artist` tag once, and its description and credits end with C's contact line.
- The YouTube identity calls carry C's bearer token.
- Disconnected C waits on `reconnect YouTube` with 0 Gemini calls.

- [ ] T019 [P] [US2] Owner-grant uploads and outcomes (research R6, R8, inventory #22):
  - **`src/lib/server/platforms/youtube/youtube.ts`:**
    - Add `ownUploads(token, channelId, count, deadline)`:
      1. `channels?mine=true&part=contentDetails`; select the item with `id === channelId`
      2. `playlistItems` (`maxResults = count + 5`, ≤ 50)
      3. `videos?part=snippet`
      - All with a bearer header and `budgetSignal(deadline)`. Returns `CatalogVideo`-shaped items, newest first, with `views` 0 (no `statistics` requested).
    - Add `DeadlineSpent` and `budgetSignal(deadline)` (R14): no time left → throw `DeadlineSpent` before any request, never `AbortSignal.timeout` with a negative value.
    - Add `identityFailure(error): 'access-lost' | 'busy' | 'app-rejected'`, exactly the R8 table. A 403 is classified by `error.errors[0].reason`.
    - Delete `recentVideos`, and its export in `index.ts:20`.
  - **Tests** in `tests/unit/lib/server/platforms/youtube/youtube.test.ts`:
    - bearer on all 3 calls, and no `key=`; no `statistics` in `part`
    - ordering; empty playlist → `[]`
    - `channels.list` with several items picks the matching one; no matching item → `access-lost`
    - an expired deadline: `DeadlineSpent`, and no `fetch` happens; a call that stalls past the deadline aborts; both classify as `busy`
    - `identityFailure`, one case per R8 input:
      - `access-lost`: 401; 403 `forbidden`, `insufficientPermissions`, `channelForbidden`, `playlistItemsNotAccessible`, an unlisted 403 reason; 404 `playlistNotFound`
      - `busy`: 403 `quotaExceeded`, `dailyLimitExceeded`, `rateLimitExceeded`, `userRateLimitExceeded`; 429; 503; a network error; an `AbortError`; `DeadlineSpent`; the channel-mismatch throw
      - `app-rejected`: `invalid_client`, `unauthorized_client`, 403 `accessNotConfigured`, 400 `keyInvalid`, a plain 400
- [ ] T020 [US2] Thread the step deadline through every read the pick and brand make, and reserve model time (research R14, inventory #36-37, #52-54). Needs T005 and T019.
  - **`src/lib/server/platforms/youtube/connection.ts`:** `accessTokenFor(uid, channelId, deadline)` throws `DeadlineSpent` when no time is left, else builds its `OAuth2Client` with `transporterOptions: { signal: budgetSignal(deadline) }`. No other timeout.
  - **`src/lib/server/platforms/youtube/youtube.ts`:** `thumbnailImage(url, deadline)` and `keyGet(path, query, deadline)` use `budgetSignal` and drop their 10 s and 15 s timers. `thumbnailImage` returns null on `DeadlineSpent` or an abort.
  - **`src/lib/server/pipeline/hashtags.ts`:** `audienceEvidence(chunks, durationSec, deadline)` passes it to `searchMusicVideos` and `videosByIds`. `pipeline.ts:163-168` and `brand.ts:201` pass the step deadline.
  - **`src/lib/server/ai/model.ts`:** export `hasModelTime(agent, deadline)` (remaining ≥ `minCallMs`).
  - **Callers:** `publishing` (`pipeline.ts:265`) and `verify` (`pipeline.ts:366`) take the handler's deadline from `runStep`; `pastedVideo` (`actions.ts:235`) passes `stepDeadline()`; brand passes its own (T027).
  - **Abort in publishing and verify:** a refresh error that `identityFailure` classifies as `busy` returns `waiting on YouTube`. Every other error keeps today's handling.
  - **Tests** in `tests/unit/lib/server/platforms/youtube/connection.test.ts` and `pipeline.test.ts`:
    - a token endpoint that never answers rejects at the deadline, not later (fake `fetch` honoring the signal)
    - an expired deadline makes no token, thumbnail or audience `fetch`
    - a slow but successful identity read that leaves less than the smart pick's `minCallMs` → `{ wait: 'model busy' }`, 0 Gemini calls, `consecutiveFailures` unchanged
    - a slow successful thumbnail read that spends the budget → the same `model busy` wait
    - an audience read out of time → `waiting on YouTube`, `consecutiveFailures` unchanged
    - the pick step then returns `waiting on YouTube`, releases the claim with its token, and makes 0 Gemini calls
    - publishing and verify on a stalled refresh return a wait, not a failure
    - existing `invalid_grant` → revoked behavior unchanged
- [ ] T021 [US2] Generalize memory (inventory #1-4, #23-27):
  - **`src/lib/server/artist/memory.ts`:**
    - Delete `ARTIST_ID`, `ARTIST_NAME` and `SEED_FACTS`.
    - `memoryOf(artistId, kind)`.
    - `artistJob`: `job.artistId !== null && owner.artistId === job.artistId`.
    - `listFacts(artist, memory)`: the derived `artist-name` fact always (R5), plus stored facts when `memory`. No contact fact.
    - `writeFeedback` uses `job.artistId`.
    - `recentFeedback(artistId)`.
    - `recordPublish(tx, artistId, record)`.
  - **Tests** in `tests/unit/lib/server/artist/memory.test.ts`:
    - C's job writes feedback to `artist-c`, and A's to `flr`.
    - A job whose `artistId` differs from the owner's current link (or a null legacy job) keeps feedback on the job.
    - The derived name always; stored facts only with `memory`.
- [ ] T022 [P] [US2] Redact YouTube text in spans (research R13, inventory #38):
  - **`src/lib/server/core/tracing.ts`:** the text `Part` gains optional `source: 'youtube'`. `redactTurns` replaces such a part with `{ type: 'text', content: '[YouTube uploads: <n>]' }`, `n` passed on the part.
  - **`src/lib/server/ai/model.ts`:** `chatJson`'s re-ask resends the original turns with their `source` tags, so the re-ask's `chat` span is redacted the same way. `sdkMessage` drops `source` before the SDK call.
  - Model replies and reasoning stay traced (AGENTS.md); they're app output (R13).
  - **Tests** in `tests/unit/lib/server/core/tracing.test.ts`, through the global Sentry mock:
    - a sentinel string in a `source: 'youtube'` part appears in no `invoke_agent` or `chat` span attribute
    - the placeholder carries the count
    - untagged text parts are kept verbatim
    - a first reply that fails to parse: the re-ask's `chat` span shows the placeholder too, and the SDK request carries the full upload text without a `source` field
- [ ] T023 [US2] Prompt and finalize (research R9, R10, R13, inventory #5-12, #29-34):
  - **`src/lib/server/ai/smart-pick.ts`:**
    - `PickContext` and `PickFixups` take `artist: { name, contactLine, curated }` and `memory: boolean`.
    - Add `GENERIC_VOICE`: `ARTIST_VOICE`'s plain-copy lines without the humor, asides and caps lines. Leave `ARTIST_VOICE` unchanged.
    - Curated: the "hacked and slashed" credit-line instruction, without any contact. Generic: "Write no credit line", and `bandcamp.credits` is `''`.
    - Every run: "Write no contact line."
    - The required-tag prompt and `context.artist` always use `artist.name`.
    - `recentUploads` moves out of the context JSON into its own text part tagged `source: 'youtube'`.
    - Line 184: "Keep the artist's slang".
    - `tagPool({ artistName, candidateLists })`.
    - `pickTags`: reserve the artist tag's `tagsLength` first, exempt it from the song-title rule, then fill model picks into what's left.
    - `finalizePick`: drop every description and credits line matching the R10 contact patterns (email, phone number, URL, `@handle`, or a leading booking/contact/email/DM label), then append `artist.contactLine` as the last body line before the closing hashtags (reserved before `clip`) and as the last credits line. Null appends nothing. A code comment says the filter is pattern-based.
    - Delete `CONTACT_LINE` and `ARTIST_CREDITS`.
  - **Tests** in `tests/unit/lib/server/ai/smart-pick.test.ts`:
    - Curated A: `ARTIST_VOICE` and the credit-line instruction present; the description ends with `Contact at flieslikerobots@gmail.com.` taken from the profile fixture, not code (SC-004).
    - Generic C: `GENERIC_VOICE`, `Test Artist`, no credit-line instruction; no "Flies Like Robots" or `flieslikerobots` anywhere in the request.
    - Contact placement, in both description and credits:
      - model output with no contact → the profile's line appended
      - a stale contact copied from uploads or feedback → stripped, the current line appended
      - phone-only (`Bookings: +1 202 555 0100`, and a bare `202-555-0100`) → stripped
      - handle-only (`@oldband`, `DM @oldband`) → stripped
      - a stale URL line → stripped
      - a changed contact → only the new line remains
      - kept: the hashtag line, the curated credit line, prose with a year or a time (`2019`, `3:45`)
      - an incorrect or truncated contact → stripped, the current line appended
      - a cleared contact (null) → none, and stale lines still stripped
      - a 5,000-character model description → the contact line survives `clip`
      - a contact line with a URL is kept exactly
    - Tags: the artist tag exactly once when the candidates include a case variant; a 100-character name survives a 500-character pool; a self-titled song (`songTitle` equal to the name) keeps the artist tag.
    - The request's `recentUploads` part is tagged `source: 'youtube'`.
- [ ] T024 [US2] Pick step (research R6, R8, R15, inventory #13, #35):
  - **`src/lib/server/pipeline/pipeline.ts` `pick()`, in this order, before any model call:**
    1. `artistProfile(job.ownerUid)`: null → `{ wait: 'Add your artist name first.' }`.
    2. `getConnection(owner)`: none → `{ wait: 'reconnect YouTube' }`.
    3. `accessTokenFor(owner, channelId, deadline)` → `ownUploads(token, channelId, 3, deadline)`. Errors go through `identityFailure`:
       - `access-lost` → `access.refused(job.id)` when there is a live token, then `{ wait: 'reconnect YouTube' }`
       - `busy` → `{ wait: 'waiting on YouTube' }`; the grant is untouched
       - `app-rejected` → throw (counts toward `consecutiveFailures`)
    4. `memory = await artistJob(job)`. `listFacts(artist, memory)`; `recentFeedback(artist.id)` only when `memory`; `approvedBrand(artist.id)` only when `memory` and `curated`.
    5. Thumbnails and audience evidence with the same deadline (T020). Audience out of time → `{ wait: 'waiting on YouTube' }`.
    6. `hasModelTime('smart-pick', deadline)` false → `{ wait: 'model busy' }`.
    7. Run the pick and store `artistName: artist.name`.
    - `recordPublish` passes `job.artistId`.
    - The shared 110 s deadline covers all of it: no new deadline.
  - **Tests** in `tests/unit/lib/server/pipeline/pipeline.test.ts`:
    - C connected: identity uses C's token; the stored pick has `artistName: 'Test Artist'`; the request body has no FLR value.
    - C disconnected (no row): `reconnect YouTube`, 0 YouTube and 0 Gemini calls, job not failed.
    - Revoked grant (`invalid_grant` on refresh): marked revoked, `reconnect YouTube`, 0 Gemini calls.
    - 401 on a read: `access.refused` called, `reconnect YouTube`.
    - 403 `quotaExceeded`, 429 and 503 on a read: `waiting on YouTube`, grant untouched, `consecutiveFailures` unchanged.
    - 403 `playlistItemsNotAccessible` and 403 `forbidden` on a read: `reconnect YouTube`, `consecutiveFailures` unchanged.
    - `invalid_client` on refresh: the step fails, and two in a row fail the job.
    - A reconnect to another channel between `getConnection` and the read: `waiting on YouTube`, then the next step reads the new channel.
    - No profile (B's legacy job): `Add your artist name first.`, 0 Gemini and 0 YouTube calls.
    - A (curated): `ARTIST_VOICE` and Nathan's contact line.
    - **No persistence:** a sentinel string in a faked upload description appears in no `jobs` or `artist_memory` row after the step (R13).
    - **Revocation:** after `disconnect(owner)`, the next pick makes 0 YouTube calls and waits (R13).
- [ ] T025 [US2] Approval validation (research R7, R9, inventory #40):
  - **`src/lib/server/jobs/actions.ts`:** `tagError` allows `pick.artistName` (not null) instead of a boolean artist flag, requires it exactly once (case-insensitive), and exempts it from the song-title rule at `:48`. `approve` passes the proposed pick.
  - **Tests** in `tests/unit/lib/server/jobs/actions.test.ts`:
    - the pick's `artistName` tag is accepted
    - missing → 422 `tags: "Keep the artist tag: Test Artist."`; twice → the same 422
    - another artist's name is rejected
    - a self-titled song: the artist tag is accepted, other title tags still rejected
    - after renaming the profile, the old pick's name is still accepted (no change to approved fields)
    - a pick with `artistName: null` accepts no artist tag and requires none
- [ ] T026 [US2] Short creation uses the current name (research R7, inventory #41):
  - **`src/lib/server/jobs/jobs.ts` `createShort`:** keeps the parent's `artistId`, null included (`soundboard_owns_job`, unchanged). `artistName` is the owner's current profile name. Tags: the parent's approved tags without the parent pick's `artistName` (case-insensitive), with the current name first and its length reserved. The parent's fields are untouched.
  - **Tests** in `tests/unit/lib/server/jobs/jobs.test.ts`:
    - same name: tags unchanged, name once
    - rename before the Short: the old name dropped, the new one first; the parent's `finalFields` byte-identical
    - legacy parent with `artistId: null` and `artistName: null`, created through the request-scoped `soundboard_app` connection: the insert passes RLS, the Short keeps `artistId: null`, and its tags gain the current name
    - a parent linked to the owner's profile: the Short keeps that `artistId`
    - the hook prompt (`short.ts` `buildHookRequest`) is unchanged and names no artist (FR-005 covers only prompts that name one)
- [ ] T027 [US2] Brand guide on the owner's grant (FR-007, research R8, R13, inventory #14-16, #28, #39, #49):
  - **`src/lib/server/artist/brand.ts`:**
    - `requireCurated(user)` replaces `requireArtist`.
    - Slots, `getBrand`, `approvedBrand`, `proposeBrand`, `approveBrand` and `discardBrandProposal` take `artistId`.
    - `proposeBrand(uid, artistId)`: `accessTokenFor(uid, channelId, deadline)` → `ownUploads(token, channelId, BRAND_VIDEOS, deadline)`, the deadline from `:192`. Outcomes per R8 return `{ wait }` or throw.
    - Before the model call: `hasModelTime('brand-guide', deadline)` false → `{ wait: 'model busy' }`.
    - The uploads go in a `source: 'youtube'` text part. The proposal stores `uploadCount`, not `basedOn`.
  - **`src/lib/brand.ts:11`:** `basedOn: string[]` → `uploadCount: number`.
  - **Routes:** update `src/routes/brand/+page.server.ts`, `src/routes/brand/+page.svelte:157` (`uploadCount`), and `src/routes/api/brand/{propose,approve,discard}/+server.ts`.
  - **Tests:** `tests/unit/lib/server/artist/brand.test.ts` and the four route tests:
    - curated A: 200; the bearer token is A's; the stored proposal has `uploadCount` and no video ID
    - C and B: 404
    - not connected or revoked: `{ wait: 'reconnect YouTube' }`, 0 Gemini calls
    - quota or 503: `{ wait: 'waiting on YouTube' }`, grant untouched
    - 403 `playlistItemsNotAccessible`: `{ wait: 'reconnect YouTube' }`
    - a slow successful read that spends the budget: `{ wait: 'model busy' }`, 0 Gemini calls
    - `invalid_client`: error
    - zero uploads: the existing 409
- [ ] T028 [P] [US2] Review and working screen (research R9, R15, inventory #42):
  - **`src/lib/components/Review.svelte`:** `pick.artistName` shows as a fixed tag outside the editable comma field. The counter includes it, and the submit sends `[artistName, ...splitTags(tagsText)]`, deduplicated case-insensitively. A pick with `artistName: null` shows no fixed tag.
  - **`src/routes/jobs/[id]/+page.svelte`:** `'Add your artist name first.'` with a link to `/settings`; `'reconnect YouTube'` during the pick with a link to Connections.
  - **Tests:** extend `tests/unit/lib/components/Review.test.ts` (fixed tag rendered, not editable, counted, submitted once even when typed again) and the job page test.
  - **E2E** in `tests/e2e/artist.spec.ts`: as C on its seeded review job, the fixed `Test Artist` tag shows, and clearing the comma field still approves with it.
- [ ] T029 👤 [US2] Delete `FLR_CHANNEL_ID` (config, needs approval; inventory #55): `deploy.sh:39,48,186`, `.env.example:15`, `playwright.config.ts:37`, `README.md:191`.
  - Then `grep -rn FLR_CHANNEL_ID src scripts deploy.sh .env.example playwright.config.ts README.md` returns nothing. `specs/` and `docs/` mentions are history and stay.

**Checkpoint**: US1 and US2 deliver the MVP. A non-Nathan user can run a full release with their own details.

---

## Phase 5: User Story 3 — The app shows the user's artist (P2)

**Goal**: footer, Bandcamp screen and page description follow the profile. Signed-out pages name no artist.

**Independent Test**: as C, the footer and Bandcamp screen show only C's values. Signed out, `/`, `/privacy` and `/terms` name no artist.

- [ ] T030 [P] [US3] Footer (FR-009, inventory #18):
  - `src/lib/components/Footer.svelte` takes `artist: { name; bandcampUrl } | null`.
  - With an artist: "Built for <name> by Ashley Childress · PolyForm Noncommercial 1.0.0", with the name linked to `bandcampUrl` (`target=_blank rel="noopener noreferrer"`) when set, and plain text otherwise.
  - Null: "Built by Ashley Childress · PolyForm Noncommercial 1.0.0".
  - `src/routes/+layout.svelte` passes `data.artist`.
  - Tests in `tests/unit/lib/components/Footer.test.ts`.
- [ ] T031 [P] [US3] Layout description and menu (FR-010, inventory #19-20):
  - `src/routes/+layout.svelte` meta description: exactly "Release agent for musicians: Gemini watches and listens to a music video, then drafts and verifies the YouTube upload."
  - The menu shows Settings for every signed-in user, and Brand guide only when `data.artist?.curated`.
  - Extend `tests/unit/routes/layout.test.ts`.
- [ ] T032 [P] [US3] Bandcamp screen (FR-008, research R12, inventory #17). Needs T004.
  - `src/lib/components/Bandcamp.svelte` deletes `EDITOR` and takes `bandcampUrl: string | null`.
  - Set: the editor is `${bandcampUrl}/edit_track`.
  - Null: no editor link, and "Add your Bandcamp URL in Settings" linking to `/settings`. The copy fields stay.
  - `src/routes/jobs/[id]/+page.svelte:324-330` passes `data.artist?.bandcampUrl ?? null`.
  - Tests in `tests/unit/lib/components/Bandcamp.test.ts`:
    - A's URL → `https://flieslikerobots.bandcamp.com/edit_track`
    - C's URL → `https://test-artist.bandcamp.com/edit_track`
    - null → the note, and no link
- [ ] T033 [P] [US3] Privacy copy (inventory #51): `src/routes/privacy/+page.svelte:24-25` says each account stores an artist name and an optional Bandcamp URL and contact line, used for drafts and display. Linked artist memory stores feedback and, for the curated profile, the brand guide. Recent uploads read for identity aren't stored. Update its test if one asserts the text.
- [ ] T034 [US3] E2E `tests/e2e/artist.spec.ts`, US3:
  - As C: the header has `Test Artist`; the footer links `https://test-artist.bandcamp.com`; the Bandcamp screen's editor link points at C's `/edit_track`.
  - The page HTML contains none of "Flies Like Robots", `flieslikerobots` or `@flieslikerobots` (SC-002).
  - Signed out on `/`, `/privacy` and `/terms`: no artist name in header or footer, and the meta description is generic (SC-006).

**Checkpoint**: US3 independently testable.

---

## Phase 6: User Story 4 — Change artist details later (P2)

**Goal**: `/settings` edits all three fields. New picks use them, and approved jobs don't change.

**Independent Test**: as C, rename on `/settings`, then re-run a review job: the new pick has the new name tag, and an approved job's `finalFields` are unchanged.

- [ ] T035 [US4] Settings page (FR-011, inventory #48):
  - `src/routes/settings/+page.server.ts` drops `requireArtist` and returns the owner's editable `artist: { name, bandcampUrl, contactLine } | null`, from `locals.user.artist` only. Signed-out requests already redirect home through `hooks.server.ts`.
  - `src/routes/settings/+page.svelte` adds an "Artist" section above Peer influence: `ArtistForm` pre-filled from `data.artist`, button "Save changes", then "Saved." and `invalidateAll()` after a 200.
  - `<title>` becomes "Settings · Soundboard".
  - Tests in `tests/unit/routes/settings/page.server.test.ts` and `page.test.ts`:
    - the loader returns C's three fields, and never another user's
    - a rename-only save keeps the stored Bandcamp URL and contact line
    - clearing the contact field stores null
- [ ] T036 [US4] Rename semantics in `tests/unit/lib/server/pipeline/pipeline.test.ts` and `tests/unit/lib/server/jobs/actions.test.ts` (SC-005). Rename C's profile, then:
  - The next re-run pick stores the new `artistName` and tag.
  - An `APPROVED` or `VERIFIED` job's `finalFields` and stored picks are byte-identical before and after.
  - A 422 on an invalid edit leaves the stored row unchanged.
- [ ] T037 [US4] E2E `tests/e2e/artist.spec.ts`, US4 (both projects, own user per project):
  - Open `/settings` and see all three fields pre-filled.
  - Clear the name and save: "Add the artist name.", and a reload shows the old name.
  - Enter `http://x` for Bandcamp: "Use your https://<name>.bandcamp.com address."
  - Enter `A, B` as the name: "Artist names can't contain commas."
  - Rename to `Renamed Band`: "Saved.", the header shows `Renamed Band`, and a reload still shows the stored Bandcamp URL and contact line.

**Checkpoint**: all four stories independently testable.

---

## Phase 7: Polish and validation

- [ ] T038 [P] Update `README.md:163-174` (FR-016):
  - New users enter their artist name on first run.
  - `--artist flr` links an invite to Nathan's existing profile.
  - Brand guide is for the curated profile, and reads through the user's own grant.
- [ ] T039 FR-013 sweep, scoped to app code and executable config:
  - `grep -rniE "flies ?like ?robots|flieslikerobots|'flr'|\"flr\"|FLR_CHANNEL_ID|ARTIST_ID|ARTIST_NAME|CONTACT_LINE" src scripts deploy.sh .env.example playwright.config.ts vite.config.ts`
  - Allowed: `scripts/invite.ts:2` (`--artist flr` usage example). `ARTIST_VOICE`'s text stays as is.
  - Review every other match: each is a bug to fix, not an exception to add. `drizzle/`, `tests/` and `specs/` are out of scope.
  - Record the command and its output in the PR description.
- [ ] T040 Validation loop (max 5 attempts, then stop with the exact errors):
  1. `make ai-checks`: coverage ≥ 85/85/85/80, zero warnings
  2. `pnpm exec playwright test`: both projects
  3. `semgrep scan --config auto --error --metrics=off` on the changed files: zero findings
  4. SonarQube `analyze_code_snippet` on each changed or added source file (project `anchildress1_soundboard`): zero issues
  5. `pnpm audit --prod` and `pnpm audit`: zero
- [ ] T041 👤 Live local validation (quickstart Q3–Q5). Gemini share ≤ $0.40.
  - **Before:** read `/private/tmp/claude-501/-Users-anchildress1-git-personal-soundboard/62e697ca-854d-4335-b7d9-d69a103885aa/scratchpad/gemini-ledger.md`.
  - **Database:** apply the migration to the dev Neon branch only after quickstart Q0 passes there (`.env` is dev-only; never print its URLs).
  - **User:** add a non-Nathan invited user with `node --env-file=.env scripts/invite.ts add <email>`. Use Ashley's own non-Nathan account with her own YouTube channel connected, never Nathan's.
  - **Run:** `pnpm dev`, then in the browser:
    1. The profile form shows on `/new`. Time first sign-in → saved profile, and record it: it must be under 1 minute (SC-001).
    2. Save `Test Artist`, a `https://<name>.bandcamp.com` URL and a contact line.
    3. Run one real release on the shortest `$HOME/Downloads/*.mp4`: one window and one pick. Log each call in the ledger.
  - **Confirm:**
    - The pick's tags have `Test Artist` exactly once, shown as the fixed tag in Review.
    - The description body and Bandcamp credits end with the contact line exactly; no credit line.
    - No FLR value appears on any screen.
    - Header and footer show `Test Artist`.
    - Disconnect YouTube and re-run: the job waits on "Reconnect YouTube", and the ledger gets no new entry.
  - **Rename:** rename in `/settings`, and re-run only if the ledger has room.
  - **No approval, no upload.**
  - **Report:** calls, tokens, and estimated spend.
- [ ] T042 After the stack rebase onto `003-resumable-upload`: if 003 added a migration numbered `0005`, regenerate this feature's migration (research R17). Drop 004's SQL, snapshot and journal entry, rerun `pnpm drizzle-kit generate --name artist_profiles`, and re-insert the T006 data block and function. Then rerun T040.
- [ ] T043 👤 Gate G1, signed-in part (research R12, quickstart Q6). Owner only: agents may not enter Nathan's Bandcamp login.
  - Signed in as Nathan, `https://flieslikerobots.bandcamp.com/edit_track` opens his track editor. Record the result and date in quickstart Q6.
  - Doesn't block implementation or merge. The PR description calls it out until it's recorded.

---

## Dependencies and execution order

- **Phase 0:** T000 is decided. T001 blocks every code task (T006 onward).
- **Setup (T002-T005):** the PRD must match before behavior code. T004 (G1, signed-out) passed, so T032 is unblocked. T005 (G2) passed, so T020 is unblocked.
- **Foundational (T006-T012)** blocks every story.
  - T006 → T007 → T008.
  - T009 [P] alongside T006.
  - T010 needs T006 and T009.
  - T011 needs T010.
  - T012 [P] after T006.
- **US1 (T013-T018)** after Foundational: T013 → T014/T015 → T018. T016 and T017 can run in parallel with T014.
- **US2 (T019-T029)** after Foundational, independent of US1 except E2E fixtures:
  - T019 [P], T021 and T022 [P] first.
  - T020 after T019.
  - Then T023 → T024 → T025 → T026.
  - T027 needs T019, T020, T021 and T022.
  - T028 [P] after T012 and T025.
  - T029 only after T024 and T027 remove the last readers.
- **US3 (T030-T034)** after T011. Its components are independent [P]; T034 last.
- **US4 (T035-T037)** after T014 (shared form) and T024 and T025 (rename semantics).
- **Polish (T038-T043)** last. T041 after T040 is green. T042 only when rebasing. T043 is the owner's, any time, and blocks nothing.

## Parallel examples

- **Foundational:** T009 (`src/lib/artist.ts`) beside T006 (schema and migration). T012 (types and fixtures) once T006 lands.
- **US1:** T014 (`ArtistForm.svelte`), T016 (`create.ts` guard) and T017 (header) together after T013.
- **US2:** T019 (`youtube.ts`), T021 (`memory.ts`) and T022 (`tracing.ts`) together.
- **US3:** T030, T031, T032 and T033 touch different files and run together.

## Implementation strategy

- **First:** T001 (constitution 3.0.0), then the docs (T002, T003).
- **MVP:** Phases 2–4 (US1 and US2). Non-Nathan users get their own drafts, and Nathan's are unchanged (SC-004).
- **Then** US3 (display) and US4 (settings edit). Each is shippable alone.
- **One PR** on `004-artist-profile`, stacked on `003-resumable-upload`. Commit per task group, signed and atomic.

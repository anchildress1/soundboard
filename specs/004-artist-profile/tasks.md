---
description: 'Task list for artist profile inputs and display'
---

# Tasks: Artist profile inputs and display

**Input**: Design documents from `specs/004-artist-profile/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/artist-profile.md](contracts/artist-profile.md), [quickstart.md](quickstart.md)

**Tests**: Required. AGENTS.md and constitution V require positive, negative, error and edge-case tests for every new module.

- Unit tests go in `tests/unit/`, mirroring `src/`. E2E tests go in `tests/e2e/`.
- Import app code through `#lib/*` and `#src/*`, with `.js` extensions.
- Mock only at process boundaries: YouTube and Gemini HTTP via `fetch`, KMS, ffmpeg. The database is PGlite with real migrations, and Sentry is the global mock.
- Each task's tests are part of that task.

**Inventory**: the `#n` numbers point at the [plan's hard-coded inventory](plan.md#hard-coded-inventory). Every entry is closed by some task below.

**Organization**: tasks are grouped by user story. US1 and US2 are P1; US3 and US4 are P2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story the task serves (US1–US4)
- 👤 Yours to run or approve. For repo config files, I draft the diff and you OK it before anything changes.

---

## Phase 1: Setup

**Purpose**: the docs agents work from. The constitution treats code that disagrees with the PRD as a stop, so these come first.

- [ ] T001 Update `docs/prd.md` (FR-016, inventory #45):
  - Header and Users (lines 5, 49): every user owns one artist profile, and Nathan's is Flies Like Robots.
  - Non-Goals (line 45): per-artist voice and brand come with spec 005.
  - R4 (lines 87, 99, 100, 103, 105):
    - Identity reads are the owner's 3 most recent uploads through the owner's grant, and only on artist jobs.
    - Nathan's voice applies to the curated profile; everyone else gets generic voice rules.
    - Tags include the owner's artist name, recorded on the pick.
    - Bandcamp copy carries the contact line, and the editor is the owner's Bandcamp URL plus `/edit_track`.
  - R5 (line 119): feedback goes to the owner's artist profile, which is `artist_memory` keyed by the profile.
  - R8: after first sign-in, the artist form appears before the first release.
  - R10 (lines 173, 178):
    - Every user has at most one profile, never shared.
    - The app claims a new profile only through `soundboard_create_artist`, and the artist link is otherwise operator-only.
  - R12 (line 194): reads the owner's uploads through their grant, and only for the curated profile.
  - Postgres table (lines 237, 240): add the `artists` row, and drop the name seed from the `artist_memory` row.
  - UX (lines 254, 256, 258):
    - The header shows the artist name.
    - Brand guide appears only for the curated profile; Settings for everyone, with an Artist section.
    - The footer's artist credit only when signed in.
  - Keep line 273.
- [ ] T002 [P] Update `AGENTS.md` (FR-016, inventory #46):
  - Line 15: `ARTIST_VOICE` applies only to `artists.curated`, and `GENERIC_VOICE` to everyone else.
  - Lines 26-27:
    - Artist memory and `/brand` are keyed by `users.artist_id` → `artists.id`.
    - `/brand` needs `curated`.
    - Identity reads use only the owner's grant.
  - Add one line: "Artist values come from `artists` only. NEVER add an FLR constant to app code."

- [x] T003 👤 Gate G1: Bandcamp editor URL (constitution V, research R11). Blocks T027.
  - Open a second artist's `https://<subdomain>.bandcamp.com/edit_track` signed out.
  - Record the result and date in `specs/004-artist-profile/quickstart.md` Q6.
  - If it 404s, stop and reopen FR-008 before T027.

---

## Phase 2: Foundational (blocks every story)

**Purpose**: schema, migration, profile access, shared types.

**⚠️ CRITICAL**: no user story work starts until this phase is green.

- [ ] T004 Schema and migration (data-model, research R1–R3, R14, inventory #42):
  - **`src/lib/server/core/schema.ts`:** add `artists` with exactly these rules:
    - `id text PK`
    - `name text not null` with `CHECK name = btrim(name) and char_length(name) between 1 and 100 and name !~ '[<>]'`
    - `bandcamp_url text` null, or `~ '^https://'` and `char_length ≤ 2000`
    - `contact_line text` null, or `= btrim(contact_line)`, `char_length between 1 and 200` and `!~ '[<>]'`
    - `curated boolean not null default false`
    - `created_at`, `updated_at` (`timestamptz`, default `now()`)
    - RLS `artists_owner` for select and update to `soundboard_app`, using `id = (select u.artist_id from public.users u where u.uid = <principal> and u.active)`
  - **Other tables:**
    - `users.artist_id` → `.unique().references(() => artists.id)`
    - `jobs.artist_id` and `artist_memory.artist_id` → `references(() => artists.id)`
    - `jobs_insert` top-level branch → `parent_id is null and artist_id is not null and artist_id = (select u.artist_id …)`
  - **Generate:** `pnpm drizzle-kit generate --name artist_profiles`.
  - **Then, before committing,** edit the generated SQL in `drizzle/0005_artist_profiles.sql`:
    - Put the data-model data block (steps 1–4) after `CREATE TABLE "artists"` and before the first foreign key, unique constraint or policy statement.
    - Append `ALTER TABLE artists FORCE ROW LEVEL SECURITY`.
    - Append `GRANT SELECT, UPDATE (name, bandcamp_url, contact_line, updated_at) ON artists TO soundboard_app`.
    - Append `CREATE FUNCTION public.soundboard_create_artist(…)` exactly as data-model specifies, with `REVOKE ALL … FROM PUBLIC` and `GRANT EXECUTE … TO soundboard_app`.
  - Never write Nathan's surname or email login anywhere.
- [ ] T005 Update `tests/helpers/db.ts`:
  - `truncate()` includes `artists`.
  - `Seed` gains `artists` and inserts them before `users`.
- [ ] T006 Migration and RLS tests in `tests/unit/lib/server/core/rls.test.ts` (extend) and a new `tests/unit/drizzle/artist-profiles.test.ts`, on a fresh PGlite before `truncate`:
  - **Migration:** the `flr` row has the R3 values and `curated = true`. The facts are `home` and `mr-kill`, with no `artist-name`.
  - **Backfill:** in the test, on its own `new PGlite()`:
    1. Apply `drizzle/0000`–`0004` by splitting each file on `--> statement-breakpoint`, in `meta/_journal.json` order.
    2. Seed, privileged:
       - a `users` row with `artist_id = 'flr'`
       - an `flr` job with two picks, and a null-artist job with one pick
       - the stored `artist-name` fact for `flr`
    3. Apply `0005`.
    4. Assert:
       - picks keep their order and gain `artistName` (`'Flies Like Robots'` / `null`) and `uploadsRead: false`
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
    - a `CHECK` violation (101-character name, `<`, non-https) raises
  - **Constraints:** two users can't link the same profile (unique). A top-level job insert with `artist_id` null is rejected by `jobs_insert`.
- [ ] T007 [P] Create `src/lib/artist.ts`:
  - `parseArtist(input: unknown): { value: ArtistInput } | { errors: ArtistFieldErrors }`, implementing research R9 exactly: trimming, empty to null, limits, `https:` with host and no credentials, `<`/`>` refused in name and contact, and the R9 messages verbatim.
  - Tests in `tests/unit/lib/artist.test.ts`:
    - valid input; empty optional fields
    - 100 vs 101 characters; 200 vs 201
    - `<`/`>` in name and contact
    - `http:`, `javascript:`, `https://user:pw@…`, an unparsable URL
    - surrounding whitespace; a non-object body
- [ ] T008 Create `src/lib/server/artist/profile.ts`:
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
- [ ] T009 Put the profile on the session (inventory #37-39):
  - `src/lib/server/auth/users.ts` `getUser` returns `artist: ArtistProfile | null`.
  - `src/hooks.server.ts:53-56` and `src/app.d.ts:5` replace `artistId` with `artist`.
  - `src/routes/+layout.server.ts:23` returns `artist: { name, bandcampUrl, curated } | null`.
  - Fix every `locals.user.artistId` reader the typecheck flags.
  - Update `tests/unit/lib/server/auth/users.test.ts`, `tests/unit/hooks.server.test.ts` and `tests/unit/routes/layout.server.test.ts`. Signed out must return `artist: null`.
- [ ] T010 [P] Shared types and fixtures:
  - **`src/lib/types.ts`:**
    - `Pick` gains `artistName: string | null` and `uploadsRead: boolean`.
    - `Wait` gains `'Add your artist name first.'`.
  - **`src/lib/status.ts`:** `WAIT_TEXT` gets the same plain text.
  - **`tests/helpers/pipeline.ts`:**
    - `USER_A` stays linked to `flr` (curated).
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
    - B has no profile. C owns its own job IDs per Playwright project.
  - Add `artistName` and `uploadsRead` to every `Pick` fixture.
  - Existing unit tests that create top-level jobs as `USER_B` (through `create()` or request-scoped inserts) switch to `USER_C`, since `jobs_insert` now requires a profile (T004). Seeded privileged rows stay as they are.

**Checkpoint**: `make ai-checks` green on the foundation, before any story.

---

## Phase 3: User Story 1 — Tell Soundboard who the artist is (P1) 🎯 MVP

**Goal**: a user without a profile gets the form on `/new`, saves it, then sees the new-release form. Jobs can't start without a profile. Nathan never sees the form.

**Independent Test**: sign in as B and open `/new`: the form shows. An empty name is refused. Save a name: the new-release form appears, and the header shows the name.

- [ ] T011 [US1] Create `src/routes/api/artist/+server.ts` (`PUT`, per contract):
  - 401 signed out
  - 422 with `fields` and "Fix the highlighted fields."
  - 200 `{ artist }`; never `id` or `curated`
  - Add `saveArtist(body)` to `src/lib/api.ts`.
  - Tests in `tests/unit/routes/api/artist/server.test.ts`: 401, 422 per field, create, update, unchanged on 422, body with `curated: true` ignored.
- [ ] T012 [P] [US1] Create `src/lib/components/ArtistForm.svelte`:
  - Props `initial`, `submitLabel`, `onsaved`.
  - Labelled inputs Artist name (required, `maxlength=100`), Bandcamp URL (`type=url`), Contact line (`maxlength=200`).
  - Field errors from the 422 shown under each field. Plain labels only.
  - Tests in `tests/unit/lib/components/ArtistForm.test.ts`: renders `initial`, shows field errors, calls `onsaved` on 200, keeps the input on error.
- [ ] T013 [US1] Gate `/new`:
  - `src/routes/new/+page.svelte` renders `ArtistForm` (heading "Who's the artist?", button "Save") when `data.artist` is null. On save it calls `invalidateAll()`, and then the existing form shows.
  - Keep the change to a wrapping `{#if}` (research R15).
  - Tests in `tests/unit/routes/new/page.test.ts`.
- [ ] T014 [US1] Refuse jobs without a profile (FR-003 AS4, inventory #35-36):
  - **`src/lib/server/jobs/create.ts`:** `409 "Add your artist name first."` before `signedUploadUrl` when `user.artist` is null, and `artistId: user.artist.id`.
  - **`src/routes/api/jobs/[id]/short/+server.ts`:** the same 409.
  - **Tests:** extend `tests/unit/lib/server/jobs/create.test.ts`, `tests/unit/routes/api/jobs/server.test.ts` and the short route test (409, no job row, no signing call; positive path stores `artist_id`).
- [ ] T015 [US1] Header name (FR-009, inventory #21): `src/routes/+layout.svelte` renders `data.artist.name` first in the header row, before the channel handle and counts, on its own row on phones like today. Extend `tests/unit/routes/layout.test.ts`.
- [ ] T016 [US1] E2E `tests/e2e/artist.spec.ts`, US1:
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

- Pick, re-run and Short use the owner's name as the required tag and in the prompt, plus the owner's contact line or none.
- Identity comes from the owner's channel through the owner's grant.
- No FLR value reaches a non-Nathan draft.

**Independent Test**: unit pipeline run as C. Gemini HTTP is faked.

- The prompt carries `Test Artist`, C's contact line, and `GENERIC_VOICE`, and no FLR value.
- The stored pick has the `Test Artist` tag once.
- The YouTube identity calls carry C's bearer token.

- [ ] T017 [P] [US2] Owner-grant uploads (research R6, inventory #22):
  - **`src/lib/server/platforms/youtube/youtube.ts`:**
    - Add `ownUploads(accessToken, count)`: `channels?mine=true&part=contentDetails`, then `playlistItems` (`maxResults = count + 5`, ≤ 50), then `videos?part=snippet`, all with a bearer header and the 15 s timeout. Returns `CatalogVideo`-shaped items, newest first, with `views` 0 (no `statistics` requested).
    - Delete `recentVideos`, and its export in `index.ts:20`.
  - **Tests** in `tests/unit/lib/server/platforms/youtube/youtube.test.ts`:
    - bearer on all 3 calls, and no `key=`
    - no `statistics` in `part`
    - ordering; no channel → `[]`; empty playlist
    - 401 → `YouTubeError` with status 401; 5xx → throws
- [ ] T018 [US2] Generalize memory (inventory #1-4, #23-27):
  - **`src/lib/server/artist/memory.ts`:**
    - Delete `ARTIST_ID`, `ARTIST_NAME` and `SEED_FACTS`.
    - `memoryOf(artistId, kind)`.
    - `artistJob`: `job.artistId !== null && owner.artistId === job.artistId`.
    - `listFacts(artist, memory)`: derived `artist-name` and `contact` (research R5), plus stored facts when `memory`.
    - `writeFeedback` uses `job.artistId`.
    - `recentFeedback(artistId)`.
    - `recordPublish(tx, artistId, record)`.
  - **Tests** in `tests/unit/lib/server/artist/memory.test.ts`:
    - C's job writes feedback to `artist-c`, and A's to `flr`.
    - A job whose `artistId` differs from the owner's current link (or a null legacy job) keeps feedback on the job.
    - Derived facts: name always, contact only when set. Stored facts only with `memory`.
- [ ] T019 [US2] Prompt and finalize (research R7, R8, R10, inventory #5-12, #29-32):
  - **`src/lib/server/ai/smart-pick.ts`:**
    - `PickContext` and `PickFixups` take `artist: { name, contactLine, curated }` and `memory: boolean`.
    - Add `GENERIC_VOICE`: `ARTIST_VOICE`'s plain-copy lines without the humor, asides and caps lines. Leave `ARTIST_VOICE` unchanged.
    - `artistCredits(artist)`:
      - Curated: the "hacked and slashed" line, then "his contact line exactly: \"<contactLine>\"" only when set.
      - Generic: a credit line only when recentUploads carry one, then the contact line exactly when set.
    - The required-tag prompt and `context.artist` always use `artist.name`.
    - The recentUploads rule applies only when `ctx.recent.length > 0`.
    - `bandcamp.credits` is always "the credit line and contact line from the description, exactly as written there".
    - Line 184: "Keep the artist's slang".
    - `tagPool({ artistName, candidateLists })`.
    - `pickTags`: reserve the artist tag's `tagsLength` first, then fill model picks into what's left.
    - Delete `CONTACT_LINE` and `ARTIST_CREDITS`.
  - **Tests** in `tests/unit/lib/server/ai/smart-pick.test.ts`:
    - Curated A: `ARTIST_VOICE` present; contact `Contact at flieslikerobots@gmail.com.` comes from the profile fixture, not code.
    - Generic C: `GENERIC_VOICE`, `Test Artist`, C's contact; no "Flies Like Robots" or `flieslikerobots`.
    - A null contact gives no contact instruction.
    - The artist tag appears exactly once when the candidates include a case variant.
    - A 100-character name survives a 500-character pool.
    - A contact line with a URL keeps that URL in the description and credits (`allowedLinks`).
- [ ] T020 [US2] Pick step (research R6, R7, R13, inventory #13, #33):
  - **`src/lib/server/pipeline/pipeline.ts` `pick()`:**
    - `artistProfile(job.ownerUid)`: null → return `{ wait: 'Add your artist name first.' }` before any YouTube or model call.
    - `memory = await artistJob(job)`.
    - Identity when `memory`:
      - `getConnection` → `accessTokenFor(owner, channelId)` → `ownUploads(token, 3)`.
      - Null access or `uploadFailure(e) === 'access-lost'` → `access.refused(job.id)` where there is access, then run with `recent = []`.
      - Other errors rethrow.
    - Pass `artist` and `memory` to `runPick`.
    - `listFacts(artist, memory)`. `recentFeedback(artist.id)` and `approvedBrand(artist.id)` only when `memory` and `curated` for the brand.
    - Store `artistName: artist.name` and `uploadsRead: recent.length > 0` on the pick.
    - `recordVerified` passes `job.artistId`.
    - The shared 110 s deadline covers the identity read: no new deadline.
  - **Tests** in `tests/unit/lib/server/pipeline/pipeline.test.ts`:
    - C connected: identity uses C's token; the stored pick has `artistName: 'Test Artist'` and `uploadsRead: true`; the request body has no FLR value.
    - C disconnected: no YouTube identity call; `uploadsRead: false`.
    - Grant refused (401): the connection is marked revoked; the pick still completes.
    - No profile (B legacy job): the wait is returned, with 0 Gemini and 0 YouTube calls.
    - A (curated): `ARTIST_VOICE` and Nathan's contact line.
    - The Short copies `artistName` from its parent pick.
    - The hook prompt (`src/lib/server/pipeline/short.ts` `buildHookRequest`) names no artist, today or after this change. Assert it contains no artist name, so FR-005 holds for hook picks.
- [ ] T021 [US2] Approval validation (research R7, inventory #34):
  - **`src/lib/server/jobs/actions.ts`:** `tagError` allows `pick.artistName` (not null) instead of a boolean artist flag. `approve` passes the proposed pick.
  - **Tests** in `tests/unit/lib/server/jobs/actions.test.ts`:
    - the pick's `artistName` tag is accepted
    - another artist's name is rejected
    - after renaming the profile, the old pick's name is still accepted (no change to approved fields)
    - a pick with `artistName: null` accepts no artist tag
- [ ] T022 [US2] Brand guide on the owner's grant (FR-007, inventory #14-16, #28, #41):
  - **`src/lib/server/artist/brand.ts`:**
    - `requireCurated(user)` replaces `requireArtist`.
    - Slots, `getBrand`, `approvedBrand`, `proposeBrand`, `approveBrand` and `discardBrandProposal` take `artistId`.
    - `proposeBrand(uid, artistId)` reads `ownUploads(token, BRAND_VIDEOS)` through the caller's grant. Not connected → `409 "Connect YouTube to read your channel."`.
  - **Routes:** update `src/routes/brand/+page.server.ts` and `src/routes/api/brand/{propose,approve,discard}/+server.ts`.
  - **Tests:** `tests/unit/lib/server/artist/brand.test.ts` and the four route tests:
    - curated A: 200
    - C and B: 404
    - not connected: 409
    - the bearer token is A's
- [ ] T023 [P] [US2] Review notices:
  - `src/lib/components/Review.svelte` shows "Drafted without your recent uploads." under Why this on the Description step when `pick.uploadsRead === false`.
  - The working screen in `src/routes/jobs/[id]/+page.svelte` shows the `'Add your artist name first.'` wait with a link to `/settings`.
  - Extend `tests/unit/lib/components/Review.test.ts` and the job page test.
- [ ] T024 👤 [US2] Delete `FLR_CHANNEL_ID` (config, needs approval; inventory #44): `deploy.sh:39,48,186`, `.env.example:15`, `playwright.config.ts:37`, `README.md:191`. Confirm `grep -rn FLR_CHANNEL_ID .` returns nothing.

**Checkpoint**: US1 and US2 deliver the MVP. A non-Nathan user can run a full release with their own details.

---

## Phase 5: User Story 3 — The app shows the user's artist (P2)

**Goal**: footer, Bandcamp screen and page description follow the profile. Signed-out pages name no artist.

**Independent Test**: as C, the footer and Bandcamp screen show only C's values. Signed out, `/`, `/privacy` and `/terms` name no artist.

- [ ] T025 [P] [US3] Footer (FR-009, inventory #18):
  - `src/lib/components/Footer.svelte` takes `artist: { name; bandcampUrl } | null`.
  - With an artist: "Built for <name> by Ashley Childress · PolyForm Noncommercial 1.0.0", with the name linked to `bandcampUrl` (`target=_blank rel="noopener noreferrer"`) when set, and plain text otherwise.
  - Null: "Built by Ashley Childress · PolyForm Noncommercial 1.0.0".
  - `src/routes/+layout.svelte` passes `data.artist`.
  - Tests in `tests/unit/lib/components/Footer.test.ts`.
- [ ] T026 [P] [US3] Layout description and menu (FR-010, inventory #19-20):
  - `src/routes/+layout.svelte` meta description: exactly "Release agent for musicians: Gemini watches and listens to a music video, then drafts and verifies the YouTube upload."
  - The menu shows Settings for every signed-in user, and Brand guide only when `data.artist?.curated`.
  - Extend `tests/unit/routes/layout.test.ts`.
- [ ] T027 [P] [US3] Bandcamp screen (FR-008, inventory #17):
  - `src/lib/components/Bandcamp.svelte` deletes `EDITOR` and takes `bandcampUrl: string | null`.
  - Set: the editor is `new URL('/edit_track', bandcampUrl).href`.
  - Null: no editor link, and "Add your Bandcamp URL in Settings" linking to `/settings`. The copy fields stay.
  - `src/routes/jobs/[id]/+page.svelte:324-330` passes `data.artist?.bandcampUrl ?? null`.
  - Tests in `tests/unit/lib/components/Bandcamp.test.ts`:
    - A's URL → `https://flieslikerobots.bandcamp.com/edit_track`
    - C's URL → `https://test-artist.bandcamp.com/edit_track`
    - null → the note, and no link
- [ ] T028 [P] [US3] Privacy copy (research R12, inventory #43): `src/routes/privacy/+page.svelte:24-25` says each account stores an artist name and an optional Bandcamp URL and contact line, used for drafts and display. Linked artist memory stores feedback and, for the curated profile, the brand guide. Update its test if one asserts the text.
- [ ] T029 [US3] E2E `tests/e2e/artist.spec.ts`, US3:
  - As C: the header has `Test Artist`; the footer links `https://test-artist.bandcamp.com`; the Bandcamp screen's editor link points at C's `/edit_track`.
  - The page HTML contains none of "Flies Like Robots", `flieslikerobots` or `@flieslikerobots` (SC-002).
  - Signed out on `/`, `/privacy` and `/terms`: no artist name in header or footer, and the meta description is generic (SC-006).

**Checkpoint**: US3 independently testable.

---

## Phase 6: User Story 4 — Change artist details later (P2)

**Goal**: `/settings` edits all three fields. New picks use them, and approved jobs don't change.

**Independent Test**: as C, rename on `/settings`, then re-run a review job: the new pick has the new name tag, and an approved job's `finalFields` are unchanged.

- [ ] T030 [US4] Settings page (FR-011, inventory #40):
  - `src/routes/settings/+page.server.ts` drops `requireArtist`. The page needs a session; signed-out requests already redirect home through `hooks.server.ts`.
  - `src/routes/settings/+page.svelte` adds an "Artist" section above Peer influence: `ArtistForm` pre-filled from `data.artist`, button "Save changes", and "Saved." after a 200.
  - `<title>` becomes "Settings · Soundboard".
  - Tests in `tests/unit/routes/settings/page.server.test.ts` and `page.test.ts`.
- [ ] T031 [US4] Rename semantics in `tests/unit/lib/server/pipeline/pipeline.test.ts` and `tests/unit/lib/server/jobs/actions.test.ts` (SC-005). Rename C's profile, then:
  - The next re-run pick stores the new `artistName` and tag.
  - An `APPROVED` or `VERIFIED` job's `finalFields` and stored picks are byte-identical before and after.
  - A 422 on an invalid edit leaves the stored row unchanged.
- [ ] T032 [US4] E2E `tests/e2e/artist.spec.ts`, US4 (both projects, own user per project):
  - Open `/settings` and see the fields pre-filled.
  - Clear the name and save: "Add the artist name.", and a reload shows the old name.
  - Enter `http://x` for Bandcamp: refused.
  - Rename to `Renamed Band`: "Saved.", and the header shows `Renamed Band`.

**Checkpoint**: all four stories independently testable.

---

## Phase 7: Polish and validation

- [ ] T033 [P] Update `README.md:163-174` (inventory #46):
  - New users enter their artist name on first run.
  - `--artist flr` links an invite to Nathan's existing profile.
  - Brand guide is for the curated profile, and reads through the user's own grant.
- [ ] T034 FR-013 sweep: `grep -rniE "flies ?like ?robots|flieslikerobots|'flr'|\"flr\"|FLR_CHANNEL_ID|ARTIST_ID|ARTIST_NAME|CONTACT_LINE" src scripts deploy.sh .env.example` returns nothing. The `flr` row and facts live only in `drizzle/`, `ARTIST_VOICE` stays as is, and tests may keep Nathan fixtures. Record the command output in the PR description.
- [ ] T035 Validation loop (brief, max 5 attempts, then stop with the exact errors):
  1. `make ai-checks`: coverage ≥ 85/85/85/80, zero warnings
  2. `pnpm exec playwright test`: both projects
  3. `semgrep scan --config auto --error --metrics=off` on the changed files: zero findings
  4. SonarQube `analyze_code_snippet` on each changed or added source file (project `anchildress1_soundboard`): zero issues
  5. `pnpm audit --prod` and `pnpm audit`: zero
- [ ] T036 👤 Live local validation (quickstart Q3–Q5). Gemini share ≤ $0.40.
  - **Before:** read `/private/tmp/claude-501/-Users-anchildress1-git-personal-soundboard/62e697ca-854d-4335-b7d9-d69a103885aa/scratchpad/gemini-ledger.md`.
  - **Database:** apply the migration to the dev Neon branch only after quickstart Q0 passes there (`.env` is dev-only; never print its URLs).
  - **User:** add a non-Nathan invited user with `node --env-file=.env scripts/invite.ts add <email>`. Use Ashley's own non-Nathan account, or a session minted by a scratchpad-only script for a seeded user, never committed.
  - **Run:** `pnpm dev`, then in the browser:
    1. The profile form shows on `/new`. Time first sign-in → saved profile, and record it: it must be under 1 minute (SC-001).
    2. Save `Test Artist`, an optional Bandcamp URL and a contact line.
    3. Run one real release on the shortest `$HOME/Downloads/*.mp4`: one window and one pick. Log each call in the ledger.
  - **Confirm:**
    - The pick's tags have `Test Artist` exactly once.
    - Description and Bandcamp credits carry the contact line.
    - No FLR value appears on any screen.
    - Header and footer show `Test Artist`.
    - With YouTube disconnected, the review shows "Drafted without your recent uploads."
  - **Rename:** rename in `/settings`, and re-run only if the ledger has room.
  - **No approval, no upload.**
  - **Report:** calls, tokens, and estimated spend.
- [ ] T037 After the stack rebase onto `003-resumable-upload`: if 003 added a migration numbered `0005`, regenerate this feature's migration (research R15). Drop 004's SQL, snapshot and journal entry, rerun `pnpm drizzle-kit generate --name artist_profiles`, and re-insert the T004 data block and functions. Then rerun T035.

---

## Dependencies and execution order

- **Setup (T001-T003)** first: the PRD must match before behavior code. T003 (Gate G1) must pass before T027.
- **Foundational (T004-T010)** blocks every story.
  - T004 → T005 → T006.
  - T007 [P] alongside T004.
  - T008 needs T004 and T007.
  - T009 needs T008.
  - T010 [P] after T004.
- **US1 (T011-T016)** after Foundational: T011 → T012/T013 → T016. T014 and T015 can run in parallel with T012.
- **US2 (T017-T024)** after Foundational, independent of US1 except E2E fixtures:
  - T017 [P] and T018 first.
  - Then T019 → T020 → T021.
  - T022 needs T017 and T018.
  - T023 [P] after T010.
  - T024 only after T020 and T022 remove the last readers.
- **US3 (T025-T029)** after T009. Its components are independent [P]; T029 last.
- **US4 (T030-T032)** after T012 (shared form) and T020 and T021 (rename semantics).
- **Polish (T033-T037)** last. T036 after T035 is green. T037 only when rebasing.

## Parallel examples

- **Foundational:** T007 (`src/lib/artist.ts`) beside T004 (schema and migration). T010 (types and fixtures) once T004 lands.
- **US1:** T012 (`ArtistForm.svelte`), T014 (`create.ts` guard) and T015 (header) together after T011.
- **US2:** T017 (`youtube.ts`) beside T018 (`memory.ts`). T023 (Review notice) beside T019.
- **US3:** T025, T026, T027 and T028 touch different files and run together.

## Implementation strategy

- **MVP:** Phases 1–4 (US1 and US2). Non-Nathan users get their own drafts, and Nathan's are unchanged (SC-004).
- **Then** US3 (display) and US4 (settings edit). Each is shippable alone.
- **One PR** on `004-artist-profile`, stacked on `003-resumable-upload`. Commit per task group, signed and atomic.

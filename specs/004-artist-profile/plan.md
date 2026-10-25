# Implementation Plan: Artist profile inputs and display

**Branch**: `004-artist-profile` | **Date**: 2026-10-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-artist-profile/spec.md`

## Summary

Every signed-in user gets one artist profile: a name, plus an optional Bandcamp URL and contact line. Every hard-coded Flies Like Robots value moves into Nathan's migrated profile.

- **Storage:** a new `artists` table. `users.artist_id` stays the link and becomes a unique foreign key, so every RLS policy keyed on it keeps working ([R1](research.md#r1--where-the-profile-lives)).
- **Create and edit:** one `SECURITY DEFINER` function claims a new profile for the caller. Edits are an RLS-checked `UPDATE` ([R2](research.md#r2--creating-and-editing-a-profile)).
- **Nathan:** the generated migration inserts the `flr` row with today's values and moves his seed facts into data. It links through his existing `users.artist_id`, with no email or `uid` in code ([R3](research.md#r3--migrating-nathans-profile)).
- **His voice and brand guide:** gated by a migration-only `artists.curated` flag, not by an ID constant ([R4](research.md#r4--who-gets-nathans-voice-and-the-brand-guide)).
- **Picks:** they read the owner's profile when they run, and identity comes from the owner's own channel through their own grant ([R6](research.md#r6--identity-reads-through-the-owners-grant)). Each pick records the name it used, and approval validates against it ([R7](research.md#r7--which-name-a-pick-and-an-approval-use)).
- **Display:** the form on `/new` and `/settings`. Header, footer, Bandcamp editor link and page description all follow the profile, or show nothing when signed out ([R12](research.md#r12--display)).

## Technical Context

**Language/Version**: TypeScript strict, Node 24 (`.nvmrc`), SvelteKit 3, Svelte 5 runes

**Primary Dependencies**: existing only: Drizzle, `google-auth-library`, `ai` + `@ai-sdk/google` (unchanged). No new packages.

**Storage**: Neon Postgres through Drizzle.

- One generated migration (`artist_profiles`): the `artists` table, foreign keys, the unique link, a tightened `jobs_insert`, `soundboard_create_artist`, grants, and the data block for Nathan's profile.
- No new `jobs` column.

**Testing**:

- Vitest on PGlite with real migrations: no database mocks, and Sentry through the global mock.
- Mocks only at process boundaries: YouTube and Gemini HTTP via `fetch`, KMS.
- Playwright on desktop Chrome and Pixel 7 against `tests/e2e/fakes/`.

**Target Platform**: Cloud Run (one service), current browsers; Pixel 7 is the primary path.

**Project Type**: web application, a single SvelteKit project

**Performance Goals**: SC-001: first sign-in to a saved profile in under 1 minute. The pick step's added identity read is 3 YouTube calls inside the existing 110 s deadline.

**Constraints**:

- No FLR value in app code (FR-013), except `ARTIST_VOICE` and the credit wording.
- Not one YouTube statistic stored (FR-015).
- The surname is never written.
- The step deadline isn't restarted in helpers.

**Scale/Scope**: a handful of invited users. About 30 source files and their tests touched ([inventory](#hard-coded-inventory)).

## Constitution Check

Gated against `.specify/memory/constitution.md` v2.0.1. Re-checked after Phase 1 design: unchanged.

| Principle                   | Status             | Notes                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Owned Data               | ✅                 | `artists` RLS: only the linked active user reads or updates the row. The link is unique (never shared), and creation goes only through `soundboard_create_artist` for the caller. Memory stays keyed by the caller's own `artist_id`. Brand is a 404 for non-curated users.                                                                                                         |
| II. Truthful Output         | ✅                 | Tags come only from candidates plus the pick's own `artistName`. Links come only from public facts, now including the contact line. The UI text is plain labels.                                                                                                                                                                                                                    |
| II. Voice grounded          | ⚠️ known           | Non-Nathan artists get `GENERIC_VOICE`: plain-copy constraints, with no persona or asides. It isn't grounded in their own writing yet. The spec's Assumption chose this, and spec 005 is the fix target (Complexity Tracking).                                                                                                                                                      |
| III. Page-driven            | ❌ known violation | Constitution III says "a missing or revoked user grant MUST return a wait reason immediately." Spec US2 AS4 and FR-007 say the pick runs without identity and says so. The plan follows the spec and records this in Complexity Tracking for the owner to decide. Everything else in III holds: no new service, and the identity read sits inside the step's shared 110 s deadline. |
| IV. Domain-grouped          | ⚠️ known           | The new reads sit in `platforms/youtube/youtube.ts`, exported through `index.ts`. The profile lives in `server/artist/profile.ts`. `ARTIST_VOICE` and the credit wording stay constants in core code: FR-013 exempts them, and spec 005 fixes them. Everything else artist-specific moves to the profile.                                                                           |
| V. Tested at the boundaries | ✅                 | New modules get positive, negative, error and edge tests. RLS and the migration backfill are tested on PGlite. Bandcamp `/edit_track` is undocumented; Gate G1 (task T003, quickstart Q6) passed on 2026-10-25 for `*.bandcamp.com`. Custom domains are unchecked.                                                                                                                  |
| VI. Simplicity              | ✅                 | One table, one function, one flag. `recentVideos`, `SEED_FACTS`, `CONTACT_LINE`, `ARTIST_ID`, `ARTIST_NAME` and `FLR_CHANNEL_ID` are deleted, with no compatibility path. The pick backfill is a one-time data update, not a runtime fallback.                                                                                                                                      |
| Platform Terms              | ✅                 | Owner-grant reads request `snippet` and `contentDetails` only. No statistics are fetched for identity, and nothing is stored from them.                                                                                                                                                                                                                                             |
| Workflow: repo config       | ⚠️ needs approval  | Delete `FLR_CHANNEL_ID` from `deploy.sh` (lines 39, 48, 186), `.env.example:15` and `playwright.config.ts:37`. README env table row 191. No `package.json` change.                                                                                                                                                                                                                  |

## Hard-coded inventory

Every Flies Like Robots value, and every gate that assumes one artist, on `main` at `fcee227`. **46 entries.** The implementation must touch each one.

### App code: values (FR-013)

| #   | File:line                                             | Value / gate                                               | Change                                                                                   |
| --- | ----------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | `src/lib/server/artist/memory.ts:6`                   | `ARTIST_ID = 'flr'`                                        | Delete. Every caller takes `artistId` from the job or profile.                           |
| 2   | `src/lib/server/artist/memory.ts:7`                   | `ARTIST_NAME = 'Flies Like Robots'`                        | Delete. The name comes from `ArtistProfile.name`.                                        |
| 3   | `src/lib/server/artist/memory.ts:29-33`               | `SEED_FACTS` (artist-name, Virginia, Mr. Kill)             | Delete. Name derived (R5); Virginia and Mr. Kill go to the migration data block.         |
| 4   | `src/lib/server/artist/memory.ts:54-73`               | `listFacts` first-use seed                                 | `listFacts(artist, memory)`: derived facts plus stored facts.                            |
| 5   | `src/lib/server/ai/smart-pick.ts:118`                 | `CONTACT_LINE` (Nathan's contact address)                  | Delete. From `artist.contactLine`.                                                       |
| 6   | `src/lib/server/ai/smart-pick.ts:121-125`             | `ARTIST_CREDITS` with the constant contact                 | `artistCredits(artist)`: curated wording or generic (R10).                               |
| 7   | `src/lib/server/ai/smart-pick.ts:13`                  | imports `ARTIST_NAME`                                      | Remove.                                                                                  |
| 8   | `src/lib/server/ai/smart-pick.ts:157-167`             | `tagPool` uses `ARTIST_NAME`                               | `tagPool({ artistName, candidateLists })`.                                               |
| 9   | `src/lib/server/ai/smart-pick.ts:170-172`             | required-tag prompt names `ARTIST_NAME`                    | Uses `artist.name`, always.                                                              |
| 10  | `src/lib/server/ai/smart-pick.ts:201`                 | `context.artist: ARTIST_NAME`                              | `artist.name`, always.                                                                   |
| 11  | `src/lib/server/ai/smart-pick.ts:231`                 | candidate filter on `ARTIST_NAME`                          | `artist.name`.                                                                           |
| 12  | `src/lib/server/ai/smart-pick.ts:376`                 | `pickTags` artist key                                      | `artist.name`; length reserved first (R8).                                               |
| 13  | `src/lib/server/pipeline/pipeline.ts:158`             | `recentVideos(required('FLR_CHANNEL_ID'))`                 | `ownUploads` through the owner's grant (R6).                                             |
| 14  | `src/lib/server/artist/brand.ts:194`                  | `recentVideos(required('FLR_CHANNEL_ID'))`                 | `ownUploads` through the caller's grant.                                                 |
| 15  | `src/lib/server/artist/brand.ts:18,163`               | `ARTIST_ID` for brand slots                                | `artist.id`.                                                                             |
| 16  | `src/lib/server/artist/brand.ts:146-148`              | `requireArtist`: `artistId !== ARTIST_ID`                  | `requireCurated(user)`: `user?.artist?.curated`.                                         |
| 17  | `src/lib/components/Bandcamp.svelte:4`                | `EDITOR = https://flieslikerobots.bandcamp.com/edit_track` | Prop `bandcampUrl`; editor derived, or the Settings note (R11).                          |
| 18  | `src/lib/components/Footer.svelte:7-10`               | "Built for Flies Like Robots" + Bandcamp link              | Prop `artist`; signed out, Ashley's credit only.                                         |
| 19  | `src/routes/+layout.svelte:15`                        | `artistId === 'flr'`                                       | `data.artist?.curated` for Brand guide; Settings for everyone.                           |
| 20  | `src/routes/+layout.svelte:29-32`                     | page description names Flies Like Robots                   | Generic description (FR-010).                                                            |
| 21  | `src/routes/+layout.svelte:41-51`                     | header shows only the channel                              | The artist name leads the row (FR-009).                                                  |
| 22  | `src/lib/server/platforms/youtube/youtube.ts:177-187` | `recentVideos` (API key, any channel)                      | Replaced by `ownUploads(accessToken, count)`, and the export dropped from `index.ts:20`. |

### App code: one-artist gates and plumbing

| #   | File:line                                                                                         | Today                                                     | Change                                                                                      |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 23  | `src/lib/server/artist/memory.ts:10-11`                                                           | `memoryOf(kind)` on `ARTIST_ID`                           | `memoryOf(artistId, kind)`.                                                                 |
| 24  | `src/lib/server/artist/memory.ts:40-51`                                                           | `artistJob` compares to `ARTIST_ID`                       | `job.artistId !== null && owner.artistId === job.artistId`.                                 |
| 25  | `src/lib/server/artist/memory.ts:85-88`                                                           | `writeFeedback` inserts `ARTIST_ID`                       | `job.artistId`.                                                                             |
| 26  | `src/lib/server/artist/memory.ts:100-110`                                                         | `recentFeedback()` on Nathan                              | `recentFeedback(artistId)`.                                                                 |
| 27  | `src/lib/server/artist/memory.ts:112-130`                                                         | `recordPublish` inserts `ARTIST_ID`                       | `recordPublish(tx, artistId, record)`; caller `pipeline.ts:347-357`.                        |
| 28  | `src/lib/server/artist/brand.ts:151,153-185`                                                      | slots and `approvedBrand()` on Nathan                     | Take `artistId`.                                                                            |
| 29  | `src/lib/server/ai/smart-pick.ts:80-98,285-293`                                                   | `PickContext.artist`, `PickFixups.artist` booleans        | `artist: { name, contactLine, curated }` plus `memory: boolean` (data-model).               |
| 30  | `src/lib/server/ai/smart-pick.ts:177-195`                                                         | identity, credits, Bandcamp credits gated on `ctx.artist` | Identity on `memory && recent.length`, voice and credits on `curated` (R10).                |
| 31  | `src/lib/server/ai/smart-pick.ts:182`                                                             | `ARTIST_VOICE` on every run                               | Only when `curated`; otherwise `GENERIC_VOICE`. Rules text unchanged.                       |
| 32  | `src/lib/server/ai/smart-pick.ts:184`                                                             | "Keep his slang"                                          | "Keep the artist's slang".                                                                  |
| 33  | `src/lib/server/pipeline/pipeline.ts:149-215`                                                     | `pick()` gates on `artistJob` only                        | Load the owner profile; wait when it's missing (R13); store `artistName` and `uploadsRead`. |
| 34  | `src/lib/server/jobs/actions.ts:39-66,126`                                                        | `tagError(…, artist: boolean)`                            | Allow `pick.artistName` (R7).                                                               |
| 35  | `src/lib/server/jobs/create.ts:50-63`                                                             | `artistId: user.artistId`, null allowed                   | `409` without a profile; `user.artist.id` (R14).                                            |
| 36  | `src/routes/api/jobs/[id]/short/+server.ts`                                                       | no profile check                                          | `409` without a profile (R14).                                                              |
| 37  | `src/lib/server/auth/users.ts:11-19`                                                              | `getUser` returns the users row                           | Also returns `artist: ArtistProfile \| null` (one join).                                    |
| 38  | `src/hooks.server.ts:53-56`, `src/app.d.ts:5`                                                     | `locals.user.artistId`                                    | `locals.user.artist`.                                                                       |
| 39  | `src/routes/+layout.server.ts:23`                                                                 | returns `artistId`                                        | Returns `artist: { name, bandcampUrl, curated } \| null`.                                   |
| 40  | `src/routes/settings/+page.server.ts:5`                                                           | `requireArtist`                                           | Signed-in only; Artist section added in `+page.svelte`.                                     |
| 41  | `src/routes/brand/+page.server.ts:5`, `src/routes/api/brand/{propose,approve,discard}/+server.ts` | `requireArtist`                                           | `requireCurated`; pass `locals.user.artist`.                                                |
| 42  | `src/lib/server/core/schema.ts:37,92,119,189`                                                     | free-text `artist_id`; `jobs_insert` allows null          | Foreign keys, unique link, tightened `jobs_insert`, `artists` table.                        |
| 43  | `src/routes/privacy/+page.svelte:24-25`                                                           | "Linked artist profiles also store…"                      | Every account stores an artist name, plus optional Bandcamp URL and contact line (R12).     |

### Config and docs (FR-016, approval needed for config)

| #   | File:line                                                                            | Value                                       | Change                                                                                                                 |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 44  | `deploy.sh:39,48,186`, `.env.example:15`, `playwright.config.ts:37`, `README.md:191` | `FLR_CHANNEL_ID`                            | Delete.                                                                                                                |
| 45  | `docs/prd.md:5,45,49,87,99,100,105,119,173,178,194,237,240,254,256,258`              | single-artist wording                       | Update R4 identity, R5, R8–R10, R12, UX header, settings and footer, Postgres table (FR-016). Line 273's metric stays. |
| 46  | `AGENTS.md:15,26-27`, `README.md:163-174`                                            | voice, `artistId` gating, brand, `--artist` | Update to profile gating, `curated`, and owner-grant identity.                                                         |

**Nothing to change:** the hook prompt (`src/lib/server/pipeline/short.ts:78-104`) and the analyst prompt name no artist, so FR-005's "name in model prompts" holds for hook picks with no change. T020 asserts it.

**Kept on purpose:** `ARTIST_VOICE` (`smart-pick.ts:106-116`) and the "hacked and slashed" credit wording (FR-013 exceptions). `README.md:17,236` (the human credit for the challenge entry). Test fixtures that model Nathan's profile (`tests/helpers/pipeline.ts:11,181-216`, `tests/e2e/fakes/fixtures.ts`), which gain a non-Nathan user beside him.

## Project Structure

### Documentation (this feature)

```text
specs/004-artist-profile/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/artist-profile.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── lib/
│   ├── artist.ts                         # new: parseArtist, field errors (shared)
│   ├── components/ArtistForm.svelte      # new: the form for /new and /settings
│   ├── components/{Bandcamp,Footer,Review}.svelte
│   ├── api.ts, types.ts, status.ts
│   └── server/
│       ├── artist/{profile.ts (new), memory.ts, brand.ts}
│       ├── ai/smart-pick.ts
│       ├── auth/users.ts
│       ├── core/{schema.ts, errors.ts}
│       ├── jobs/{create.ts, actions.ts}
│       ├── pipeline/pipeline.ts
│       └── platforms/youtube/{youtube.ts, index.ts}
├── routes/
│   ├── +layout.server.ts, +layout.svelte
│   ├── api/artist/+server.ts             # new: PUT
│   ├── api/jobs/+server.ts, api/jobs/[id]/short/+server.ts
│   ├── api/brand/*, brand/+page.server.ts
│   ├── new/+page.svelte
│   ├── settings/+page.server.ts, settings/+page.svelte
│   ├── jobs/[id]/+page.svelte
│   └── privacy/+page.svelte
├── hooks.server.ts, app.d.ts
drizzle/
└── 0005_artist_profiles.sql (+ meta)     # generated; data block inserted before FKs
tests/
├── unit/  (mirrors src/; new: lib/artist.test.ts, server/artist/profile.test.ts, routes/api/artist/server.test.ts)
└── e2e/   (new: artist.spec.ts; fakes/fixtures.ts gains user C and the no-profile user B)
```

**Structure Decision**: the existing single SvelteKit project. New server code goes in `src/lib/server/artist/` (domain) and `src/lib/server/platforms/youtube/` (platform), per constitution IV.

## Complexity Tracking

| Violation                                                                         | Why Needed                                                                      | Simpler Alternative Rejected Because                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ARTIST_VOICE` and credit wording stay constants in core code (IV)                | Spec FR-013 exempts Nathan's voice rules until spec 005                         | Moving voice to data is spec 005's scope. Fix target: spec 005.                                                                                                                                                    |
| Pick runs without identity on a missing or revoked grant instead of waiting (III) | Spec US2 AS4 and FR-007: a draft without recent uploads beats a stalled release | Owner decision needed: either a PATCH amendment via `/speckit-constitution` scoping III's wait rule to steps that need the grant, or a spec change to wait on `reconnect YouTube`. Fix target: before T020 merges. |
| `GENERIC_VOICE` isn't grounded in the artist's own writing (II)                   | Spec Assumption: generic rules until per-artist voice                           | Learning each artist's voice is spec 005. Fix target: spec 005.                                                                                                                                                    |
| `curated` flag on the profile                                                     | Selects Nathan's voice and brand without an FLR constant (FR-013)               | An `id === 'flr'` check is smaller, but it's an FLR value in code. Open question for the owner.                                                                                                                    |

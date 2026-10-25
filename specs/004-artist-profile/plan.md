# Implementation Plan: Artist profile inputs and display

**Branch**: `004-artist-profile` | **Date**: 2026-10-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-artist-profile/spec.md`

## Summary

Every signed-in user gets one artist profile: a name, plus an optional Bandcamp URL and contact line. Every hard-coded Flies Like Robots value moves into Nathan's migrated profile.

- **Storage:** a new `artists` table. `users.artist_id` stays the link and becomes a unique foreign key, so every RLS policy keyed on it keeps working ([R1](research.md#r1--where-the-profile-lives)).
- **Create and edit:** one `SECURITY DEFINER` function claims a new profile for the caller. Edits are an RLS-checked `UPDATE` ([R2](research.md#r2--creating-and-editing-a-profile)).
- **Nathan:** the generated migration inserts the `flr` row with today's values and moves his seed facts into data. It links through his existing `users.artist_id`, with no email or `uid` in code ([R3](research.md#r3--migrating-nathans-profile)).
- **His voice and brand guide:** gated by a migration-only `artists.curated` flag, not by an ID constant. Spec 005 deletes the flag ([R4](research.md#r4--nathans-voice-and-the-brand-guide)).
- **Constitution:** III holds (a missing grant waits). II gains the permanent required-artist-tag exception. II and IV get temporary voice exceptions until spec 005, through a MAJOR amendment to 3.0.0 before any code task ([R0](research.md#r0--constitution-gate-t000-decided)).
- **Picks:** they read the owner's profile when they run. Identity comes from the owner's own channel through their own grant, inside the step's 110 s deadline, or the pick waits ([R6](research.md#r6--identity-reads-through-the-owners-grant), [R8](research.md#r8--identity-read-outcomes-platform-layer), [R14](research.md#r14--step-deadline)).
- **Names and tags:** each pick records the name it used, and approval requires that tag exactly once. A Short uses the owner's current name ([R7](research.md#r7--which-name-a-pick-an-approval-and-a-short-use), [R9](research.md#r9--the-required-artist-tag)).
- **Contact line:** placed by code at the end of the description body and the Bandcamp credits, never written by the model ([R10](research.md#r10--voice-credits-and-the-contact-line)).
- **YouTube data:** identity reads are never stored, YouTube text is redacted in Sentry spans, and the brand proposal keeps a count instead of video IDs ([R13](research.md#r13--retention-and-revocation-of-youtube-data)).
- **Display:** the form on `/new` and `/settings`. Header, footer, Bandcamp editor link and page description all follow the profile, or show nothing when signed out ([contract](contracts/artist-profile.md#page-data-and-screens)).

## Technical Context

**Language/Version**: TypeScript strict, Node 24 (`.nvmrc`), SvelteKit 3, Svelte 5 runes

**Primary Dependencies**: existing only: Drizzle, `google-auth-library` 11.1.0 (`transporterOptions.signal`, gate G2), `ai` + `@ai-sdk/google` (unchanged). No new packages.

**Storage**: Neon Postgres through Drizzle.

- One generated migration (`artist_profiles`): the `artists` table, foreign keys, the unique link, a tightened `jobs_insert`, `soundboard_create_artist`, grants, and the data block for Nathan's profile and the brand `uploadCount` conversion.
- No new `jobs` column.

**Testing**:

- Vitest on PGlite with real migrations: no database mocks, and Sentry through the global mock.
- Mocks only at process boundaries: YouTube and Gemini HTTP via `fetch`, KMS.
- Playwright on desktop Chrome and Pixel 7 against `tests/e2e/fakes/`.

**Target Platform**: Cloud Run (one service), current browsers; Pixel 7 is the primary path.

**Project Type**: web application, a single SvelteKit project

**Performance Goals**: SC-001: first sign-in to a saved profile in under 1 minute. The pick step's identity read is a token refresh plus 3 YouTube calls, all bounded by the existing 110 s deadline.

**Constraints**:

- No FLR value in app code (FR-013), except `ARTIST_VOICE` and the credit wording.
- Not one YouTube statistic stored (FR-015), and no identity-read text stored or traced.
- The surname is never written.
- The step deadline isn't restarted in helpers.

**Scale/Scope**: a handful of invited users. About 35 source files and their tests touched ([inventory](#hard-coded-inventory)).

## Constitution Check

Gated against `.specify/memory/constitution.md` v2.0.1. **T000 (decided 2026-10-25):** amend to 3.0.0 (MAJOR) in T001, before any code task. Re-checked after Phase 1 design: unchanged.

| Principle                   | Status                 | Notes                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Owned Data               | ✅                     | `artists` RLS: only the linked active user reads or updates the row. The link is unique (never shared), and creation goes only through `soundboard_create_artist` for the caller. Memory stays keyed by the caller's own `artist_id`. Brand is a 404 for non-curated users.                                                                                                   |
| II. Truthful Output         | ⚠️ exception (T001)    | Tags come only from candidates plus the pick's own `artistName`. T001 writes that one-tag exception into II (PRD R4 already has it; permanent). The contact line is placed by code, never by the model. The UI text is plain labels.                                                                                                                                          |
| II. Voice grounded          | ⚠️ exception (T001)    | Non-curated artists get `GENERIC_VOICE`, not their own writing. T001 adds an explicit exception, removed by spec 005 (R0).                                                                                                                                                                                                                                                    |
| III. Page-driven            | ✅                     | A missing, revoked or refused grant returns `reconnect YouTube`; quota, rate limits, 5xx, an abort and a spent deadline return `waiting on YouTube`; too little time left for the model returns `model busy` (R8, R14). No new service. Every read the pick makes, token refresh, thumbnails and audience included, is bounded by the step's shared 110 s deadline (gate G2). |
| IV. Domain-grouped          | ⚠️ exception (T001)    | `ARTIST_VOICE` and Nathan's credit wording stay constants in `smart-pick.ts`. T001 adds an explicit exception, removed by spec 005. The new reads and `identityFailure` sit in `platforms/youtube/`; the profile lives in `server/artist/profile.ts`.                                                                                                                         |
| V. Tested at the boundaries | ⚠️ owner check pending | New modules get positive, negative, error and edge tests. RLS and the migration backfill are tested on PGlite. Gate G1 (T004): signed-out redirect verified for every accepted Bandcamp URL; the signed-in editor check is the owner's (T043), non-blocking, called out in the PR. Gate G2 (T005) passed.                                                                     |
| VI. Simplicity              | ✅                     | One table, one function, one flag (deleted by spec 005). `recentVideos`, `SEED_FACTS`, `CONTACT_LINE`, `ARTIST_ID`, `ARTIST_NAME` and `FLR_CHANNEL_ID` are deleted, with no compatibility path. The backfill is a one-time data update, not a runtime fallback.                                                                                                               |
| Platform Terms              | ✅                     | Owner-grant reads request `snippet` and `contentDetails` only, never statistics. Identity reads live only in step memory; Sentry gets a placeholder; brand stores a count, not video IDs (R13). Disconnect stops every read.                                                                                                                                                  |
| Workflow: repo config       | ⚠️ needs approval      | Delete `FLR_CHANNEL_ID` from `deploy.sh` (lines 39, 48, 186), `.env.example:15` and `playwright.config.ts:37`. README env table row 191. No `package.json` change.                                                                                                                                                                                                            |

## Hard-coded inventory

Every Flies Like Robots value, and every gate or path that assumes one artist, on `main` at `fcee227`. **55 entries.** The implementation must touch each one.

### App code: values (FR-013)

| #   | File:line                                             | Value / gate                                               | Change                                                                                                                        |
| --- | ----------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/lib/server/artist/memory.ts:6`                   | `ARTIST_ID = 'flr'`                                        | Delete. Every caller takes `artistId` from the job or profile.                                                                |
| 2   | `src/lib/server/artist/memory.ts:7`                   | `ARTIST_NAME = 'Flies Like Robots'`                        | Delete. The name comes from `ArtistProfile.name`.                                                                             |
| 3   | `src/lib/server/artist/memory.ts:29-33`               | `SEED_FACTS` (artist-name, Virginia, Mr. Kill)             | Delete. Name derived (R5); Virginia and Mr. Kill go to the migration data block.                                              |
| 4   | `src/lib/server/artist/memory.ts:54-73`               | `listFacts` first-use seed                                 | `listFacts(artist, memory)`: the derived name plus stored facts.                                                              |
| 5   | `src/lib/server/ai/smart-pick.ts:118`                 | `CONTACT_LINE` (Nathan's contact address)                  | Delete. `artist.contactLine`, placed by `finalizePick` (R10).                                                                 |
| 6   | `src/lib/server/ai/smart-pick.ts:121-125`             | `ARTIST_CREDITS` with the constant contact                 | Curated only: the credit-line instruction, without the contact. Generic: no credit line (R10).                                |
| 7   | `src/lib/server/ai/smart-pick.ts:13`                  | imports `ARTIST_NAME`                                      | Remove.                                                                                                                       |
| 8   | `src/lib/server/ai/smart-pick.ts:157-167`             | `tagPool` uses `ARTIST_NAME`                               | `tagPool({ artistName, candidateLists })`.                                                                                    |
| 9   | `src/lib/server/ai/smart-pick.ts:170-172`             | required-tag prompt names `ARTIST_NAME`                    | Uses `artist.name`, always.                                                                                                   |
| 10  | `src/lib/server/ai/smart-pick.ts:201`                 | `context.artist: ARTIST_NAME`                              | `artist.name`, always.                                                                                                        |
| 11  | `src/lib/server/ai/smart-pick.ts:231`                 | candidate filter on `ARTIST_NAME`                          | `artist.name`.                                                                                                                |
| 12  | `src/lib/server/ai/smart-pick.ts:374-392`             | `pickTags`: artist key added last, title rule at `:377`    | Reserve the artist tag first; exempt it from the song-title rule (R9).                                                        |
| 13  | `src/lib/server/pipeline/pipeline.ts:158`             | `recentVideos(required('FLR_CHANNEL_ID'))`                 | `ownUploads` through the owner's grant, with the step deadline (R6, R14).                                                     |
| 14  | `src/lib/server/artist/brand.ts:194`                  | `recentVideos(required('FLR_CHANNEL_ID'))`                 | `ownUploads` through the caller's grant, with the deadline at `:192`.                                                         |
| 15  | `src/lib/server/artist/brand.ts:18,163`               | `ARTIST_ID` for brand slots                                | `artist.id`.                                                                                                                  |
| 16  | `src/lib/server/artist/brand.ts:146-148`              | `requireArtist`: `artistId !== ARTIST_ID`                  | `requireCurated(user)`: `user?.artist?.curated`.                                                                              |
| 17  | `src/lib/components/Bandcamp.svelte:4`                | `EDITOR = https://flieslikerobots.bandcamp.com/edit_track` | Prop `bandcampUrl`; editor derived, or the Settings note (R12).                                                               |
| 18  | `src/lib/components/Footer.svelte:7-10`               | "Built for Flies Like Robots" + Bandcamp link              | Prop `artist`; signed out, Ashley's credit only.                                                                              |
| 19  | `src/routes/+layout.svelte:15`                        | `artistId === 'flr'`                                       | `data.artist?.curated` for Brand guide; Settings for everyone.                                                                |
| 20  | `src/routes/+layout.svelte:29-32`                     | page description names Flies Like Robots                   | Generic description (FR-010).                                                                                                 |
| 21  | `src/routes/+layout.svelte:41-51`                     | header shows only the channel                              | The artist name leads the row (FR-009).                                                                                       |
| 22  | `src/lib/server/platforms/youtube/youtube.ts:177-187` | `recentVideos` (API key, any channel)                      | Replaced by `ownUploads(token, channelId, count, deadline)` and `identityFailure` (R6, R8). Drop the export at `index.ts:20`. |

### App code: one-artist gates and plumbing

| #   | File:line                                                                                                                          | Today                                                     | Change                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 23  | `src/lib/server/artist/memory.ts:10-11`                                                                                            | `memoryOf(kind)` on `ARTIST_ID`                           | `memoryOf(artistId, kind)`.                                                                                                  |
| 24  | `src/lib/server/artist/memory.ts:40-51`                                                                                            | `artistJob` compares to `ARTIST_ID`                       | `job.artistId !== null && owner.artistId === job.artistId`.                                                                  |
| 25  | `src/lib/server/artist/memory.ts:85-88`                                                                                            | `writeFeedback` inserts `ARTIST_ID`                       | `job.artistId`.                                                                                                              |
| 26  | `src/lib/server/artist/memory.ts:100-110`                                                                                          | `recentFeedback()` on Nathan                              | `recentFeedback(artistId)`.                                                                                                  |
| 27  | `src/lib/server/artist/memory.ts:112-130`                                                                                          | `recordPublish` inserts `ARTIST_ID`                       | `recordPublish(tx, artistId, record)`; caller `pipeline.ts:347-357`.                                                         |
| 28  | `src/lib/server/artist/brand.ts:151,153-185`                                                                                       | slots and `approvedBrand()` on Nathan                     | Take `artistId`.                                                                                                             |
| 29  | `src/lib/server/ai/smart-pick.ts:80-98,285-293`                                                                                    | `PickContext.artist`, `PickFixups.artist` booleans        | `artist: { name, contactLine, curated }` plus `memory: boolean` (data-model).                                                |
| 30  | `src/lib/server/ai/smart-pick.ts:177-195`                                                                                          | identity, credits, Bandcamp credits gated on `ctx.artist` | Identity on every pick; stored facts on `memory`; voice and credit line on `curated`; "write no contact line" for all (R10). |
| 31  | `src/lib/server/ai/smart-pick.ts:182`                                                                                              | `ARTIST_VOICE` on every run                               | Only when `curated`; otherwise `GENERIC_VOICE`. Rules text unchanged.                                                        |
| 32  | `src/lib/server/ai/smart-pick.ts:184`                                                                                              | "Keep his slang"                                          | "Keep the artist's slang".                                                                                                   |
| 33  | `src/lib/server/ai/smart-pick.ts:215`                                                                                              | `recentUploads` inside the context JSON                   | Its own text part, tagged `source: 'youtube'` (R13).                                                                         |
| 34  | `src/lib/server/ai/smart-pick.ts:399`                                                                                              | `finalizePick` keeps model contact text                   | Strip model contact lines; append the profile's contact to body and credits (R10).                                           |
| 35  | `src/lib/server/pipeline/pipeline.ts:149-215`                                                                                      | `pick()` gates identity on `artistJob`                    | Profile wait (R15); identity outcomes (R8); store `artistName`.                                                              |
| 36  | `src/lib/server/pipeline/pipeline.ts:265,366`, `src/lib/server/jobs/actions.ts:235`                                                | `accessTokenFor` without a deadline                       | Pass the step's deadline (R14).                                                                                              |
| 37  | `src/lib/server/platforms/youtube/connection.ts:130-148`                                                                           | `accessTokenFor(uid, channelId)`; refresh unbounded       | `accessTokenFor(uid, channelId, deadline)` with `transporterOptions.signal` (R14).                                           |
| 38  | `src/lib/server/core/tracing.ts:60`                                                                                                | `redactTurns` keeps every text part                       | `source: 'youtube'` parts become `[YouTube uploads: <n>]` (R13).                                                             |
| 39  | `src/lib/server/artist/brand.ts:97,226,269`, `src/lib/brand.ts:11`, `src/routes/brand/+page.svelte:157`                            | uploads in the prompt JSON; `basedOn` video IDs stored    | Uploads tagged `source: 'youtube'`; `uploadCount: number` (R13).                                                             |
| 40  | `src/lib/server/jobs/actions.ts:39-66,126`                                                                                         | `tagError(…, artist: boolean)`; title rule at `:48`       | Allow and require `pick.artistName` exactly once; exempt it from the title rule (R9).                                        |
| 41  | `src/lib/server/jobs/jobs.ts:438-450`                                                                                              | `createShort` copies the parent pick                      | Keeps the parent's `artistId`; current profile name and rebuilt tags (R7).                                                   |
| 42  | `src/lib/components/Review.svelte:58,63`                                                                                           | every tag lives in the comma field                        | `pick.artistName` as a fixed tag outside it (R9).                                                                            |
| 43  | `src/lib/server/jobs/create.ts:50-63`                                                                                              | `artistId: user.artistId`, null allowed                   | `409` without a profile; `user.artist.id` (R16).                                                                             |
| 44  | `src/routes/api/jobs/[id]/short/+server.ts`                                                                                        | no profile check                                          | `409` without a profile (R16).                                                                                               |
| 45  | `src/lib/server/auth/users.ts:11-19`                                                                                               | `getUser` returns the users row                           | Also returns `artist: ArtistProfile \| null` (one join).                                                                     |
| 46  | `src/hooks.server.ts:53-56`, `src/app.d.ts:5`                                                                                      | `locals.user.artistId`                                    | `locals.user.artist`.                                                                                                        |
| 47  | `src/routes/+layout.server.ts:23`                                                                                                  | returns `artistId`                                        | Returns `artist: { name, bandcampUrl, curated } \| null`.                                                                    |
| 48  | `src/routes/settings/+page.server.ts:5-7`                                                                                          | `requireArtist`, returns `{}`                             | Signed-in only; returns the owner's editable profile; Artist section in `+page.svelte`.                                      |
| 49  | `src/routes/brand/+page.server.ts:5`, `src/routes/api/brand/{propose,approve,discard}/+server.ts`                                  | `requireArtist`                                           | `requireCurated`; pass `locals.user.artist`.                                                                                 |
| 50  | `src/lib/server/core/schema.ts:37,92,119,189`                                                                                      | free-text `artist_id`; `jobs_insert` allows null          | Foreign keys, unique link, tightened `jobs_insert`, `artists` table.                                                         |
| 51  | `src/routes/privacy/+page.svelte:24-25`                                                                                            | "Linked artist profiles also store…"                      | Every account stores an artist name, plus optional Bandcamp URL and contact line.                                            |
| 52  | `src/lib/server/ai/model.ts:150,206-222`                                                                                           | budget shortfall throws (a failure); re-ask turns         | `hasModelTime(agent, deadline)` for a `model busy` wait; re-ask keeps the `source` tags; `sdkMessage` drops them (R13, R14). |
| 53  | `src/lib/server/platforms/youtube/youtube.ts:59,217`                                                                               | fixed 15 s (`keyGet`) and 10 s (`thumbnailImage`) timers  | `budgetSignal(deadline)` (R14).                                                                                              |
| 54  | `src/lib/server/pipeline/hashtags.ts:130-142`, `src/lib/server/pipeline/pipeline.ts:163-168`, `src/lib/server/artist/brand.ts:201` | audience and thumbnail reads without the step deadline    | Pass the deadline; out of time → wait (R14).                                                                                 |

### Config (approval needed)

| #   | File:line                                                                            | Value            | Change  |
| --- | ------------------------------------------------------------------------------------ | ---------------- | ------- |
| 55  | `deploy.sh:39,48,186`, `.env.example:15`, `playwright.config.ts:37`, `README.md:191` | `FLR_CHANNEL_ID` | Delete. |

**Docs updated alongside (FR-016):** `.specify/memory/constitution.md` (T001); `docs/prd.md:5,45,49,87,99,100,105,119,173,178,187,194,237,240,254,256,258` (T002, line 273's metric stays); `AGENTS.md:15,26-27,38` (T003); `README.md:163-174` (T038).

**Nothing to change:**

- The hook prompt (`src/lib/server/pipeline/short.ts:78-104`) and the analyst prompt name no artist. FR-005 covers only prompts that name the artist.
- `src/lib/metadata.ts:33,64` (`splitTags`, the `#` tag rule): the FR-004 name rules keep every accepted name one valid tag.

**Kept on purpose:**

- `ARTIST_VOICE` (`smart-pick.ts:106-116`) and the "hacked and slashed" credit wording (FR-013 and the T001 exception).
- `README.md:17,236`: the human credit for the challenge entry.
- Test fixtures that model Nathan's profile (`tests/helpers/pipeline.ts:11,181-216`, `tests/e2e/fakes/fixtures.ts`). They gain a non-Nathan user beside him.
- `scripts/invite.ts:2`: the `--artist flr` usage example, an operator command for Nathan's existing profile.

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
│   ├── api.ts, types.ts, status.ts, brand.ts
│   └── server/
│       ├── artist/{profile.ts (new), memory.ts, brand.ts}
│       ├── ai/smart-pick.ts
│       ├── auth/users.ts
│       ├── core/{schema.ts, errors.ts, tracing.ts}
│       ├── jobs/{create.ts, actions.ts, jobs.ts}
│       ├── pipeline/pipeline.ts
│       └── platforms/youtube/{youtube.ts, connection.ts, index.ts}
├── routes/
│   ├── +layout.server.ts, +layout.svelte
│   ├── api/artist/+server.ts             # new: PUT
│   ├── api/jobs/+server.ts, api/jobs/[id]/short/+server.ts
│   ├── api/brand/*, brand/+page.server.ts, brand/+page.svelte
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

| Violation                                                          | Why Needed                                                        | Simpler Alternative Rejected Because                                                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ARTIST_VOICE` and credit wording stay constants in core code (IV) | Spec FR-013 exempts Nathan's voice rules until spec 005           | Moving voice to data is spec 005's scope. Recorded as an explicit constitution exception (T001, MAJOR 3.0.0); spec 005 removes it. |
| `GENERIC_VOICE` isn't grounded in the artist's own writing (II)    | Spec Assumption: generic rules until per-artist voice             | Learning each artist's voice is spec 005. Recorded as an explicit constitution exception (T001); spec 005 removes it.              |
| `curated` flag on the profile                                      | Selects Nathan's voice and brand without an FLR constant (FR-013) | An `id === 'flr'` check is smaller, but it's an FLR value in code. Owner decision; spec 005 deletes the column.                    |

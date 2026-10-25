# Research: Artist profile inputs and display

Checked 2026-10-25 against:

- the code on `main` at `fcee227` (every file:line in [plan.md](plan.md#hard-coded-inventory))
- migration `drizzle/0004_tenant_rls.sql` (RLS, grants, `soundboard_admit`, `soundboard_owns_job`)
- YouTube Data API: the [`videos` resource](https://developers.google.com/youtube/v3/docs/videos), [`channels.list`](https://developers.google.com/youtube/v3/docs/channels/list), the [error reference](https://developers.google.com/youtube/v3/docs/errors)
- YouTube API Services [Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.D, III.E.3 and III.E.4
- Sentry [data retention periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/)
- installed `google-auth-library` 11.1.0 and `gaxios` 7.3.1 types (`AuthClientOptions.transporterOptions`, `GaxiosOptions extends RequestInit`)

Decisions marked **(owner)** were made on 2026-10-25 and are binding. They're recorded in spec Clarifications.

## R0 · Constitution gate (T000, decided)

- **III, grant waits:** constitution III wins **(owner)**. A missing or revoked grant makes the pick wait. Spec US2 AS4 and FR-007 were rewritten to match, so no III violation remains.
- **II and IV, temporary exceptions:** two rules can't hold until spec 005:
  - II: "Description voice MUST be grounded in the artist's own writing". Non-curated artists get `GENERIC_VOICE`.
  - IV: "Artist-specific values (name, voice, channel IDs) MUST NOT be constants in core code". `ARTIST_VOICE` and Nathan's credit wording stay in `smart-pick.ts`.
  - Both become explicit, time-boxed exceptions, removed by spec 005.
- **II, the required artist tag:** "Hashtags and tags MUST come from the job's candidate lists" gains the exception PRD R4 already states: the pick's own `artistName` is the one tag allowed outside them, exactly once. This one is permanent.
- **Classification: MAJOR (2.0.1 → 3.0.0).** Governance reads: "MAJOR for removed or redefined principles, MINOR for added or expanded ones, PATCH for wording."
  - An exception narrows what a MUST requires, so it redefines the principle.
  - Precedent: `cef38f2` added the II peer-influence exception and the III exceptions, and bumped 1.0.3 → 2.0.0.
  - Spec 005's removal of the exceptions is also a redefinition (MAJOR).
- **Mechanism:** `/speckit-constitution` on this branch (task T001), before any code task (T006 on).

## R1 · Where the profile lives

- **Decision:** a new `artists` table. `users.artist_id` stays the link and gains a foreign key to `artists.id` and a unique constraint.
  - One column per user means at most one profile per account, and unique means it's never shared (FR-001).
  - Nathan's row keeps the ID `flr`.
- **Rationale:**
  - Every existing policy keys on `users.artist_id` (`memory_artist`, `jobs_insert`, `soundboard_owns_job`), so they keep working.
  - `artistJob` keeps its meaning without a constant.
- **Alternatives:**
  - `artists.owner_uid`: forces a rewrite of every policy, and can't seed Nathan while his `uid` is unbound. Rejected.
  - Profile columns on `users`: the app has no `UPDATE` there (PRD R10). Rejected.

## R2 · Creating and editing a profile

- **Create:** `soundboard_create_artist(p_name, p_bandcamp, p_contact)`, `SECURITY DEFINER`.
  - Locks the caller's active `users` row `FOR UPDATE`, refuses an existing link (`23505`), inserts with `gen_random_uuid()::text`, sets `users.artist_id`.
  - Concurrent second save: `23505`, then the handler updates instead.
- **Edit:** an RLS-checked `UPDATE` with `UPDATE (name, bandcamp_url, contact_line, updated_at)` only. Never `curated` or `id`.
- **Rationale:** artist assignment stays out of reach of ordinary queries. The only new path is "claim one profile for myself, once", mirroring `soundboard_admit`.

## R3 · Migrating Nathan's profile

- **Decision:** one migration, `drizzle-kit generate --name artist_profiles`. Before it's committed or applied anywhere, a data block goes between `CREATE TABLE artists` and the foreign keys and unique constraint. Editing an unapplied migration is allowed.
  1. `INSERT` `flr`: name `Flies Like Robots`, Bandcamp `https://flieslikerobots.bandcamp.com`, contact `Contact at flieslikerobots@gmail.com.`, `curated = true`. These are today's values from `Footer.svelte:8`, `Bandcamp.svelte:4` and `smart-pick.ts:118`.
  2. `INSERT … ON CONFLICT DO NOTHING` the `home` (Virginia, FACT, public) and `mr-kill` (INFERENCE, private) facts for `flr`.
  3. `DELETE` the stored `artist-name` fact for `flr`; it's derived now (R5).
  4. Backfill every stored pick with `artistName`: `'Flies Like Robots'` on `flr` jobs, `null` elsewhere (R7).
  5. Brand rows: replace `basedOn` (video IDs) with `uploadCount` (R13).
- **Linking:** none needed. Nathan's row already has `artist_id = 'flr'`. No email or `uid` appears in code or SQL.
- **"Replaces the operator-assigned link":** profiles are self-created now. `--artist` survives only to attach an invite to an existing profile (Nathan's `flr` in a fresh environment). It never creates one.
- **Fail loud:** any other `artist_id` value, or two users linked to `flr`, aborts the migration. Quickstart Q0 checks first.
- **Alternatives:**
  - A hand-run seed script: forgettable, and not atomic with the schema. Rejected.
  - A first-use seed in code: keeps FLR values in code (FR-013). Rejected.

## R4 · Nathan's voice and the brand guide

- **Decision (owner):** `artists.curated boolean not null default false`. Only the migration sets it, for `flr`, and the app can't write it.
  - It selects `ARTIST_VOICE` and Nathan's credit line.
  - It gates `/brand` and the brand APIs.
- **Removal:** spec 005 deletes `curated` and both R0 exceptions, replacing them with per-artist voice and brand. Recorded for spec 005's planner.
- **Rejected:** an `id === 'flr'` constant (breaks FR-013), and an env var (config for one row).

## R5 · Artist facts

- **Decision:** `listFacts(artist, memory)` returns the derived `artist-name` fact (FACT, public, FR-014) always. It returns stored facts only when `memory` (`artistJob`) is true. `SEED_FACTS` and the first-use seed are deleted.
- **The contact line is not a fact.** The server places it (R10), so it never passes through `allowedLinks`. A link in it survives exactly as written.

## R6 · Identity reads through the owner's grant

- **Decision:** `ownUploads(token, channelId, count, deadline)` in `platforms/youtube/youtube.ts` replaces the key-based `recentVideos`, which is deleted.
  1. `channels.list?mine=true&part=contentDetails`. The response is a collection, so it selects only the item whose `id === channelId`. No match counts as `access-lost` (R8).
  2. `playlistItems.list?part=contentDetails&maxResults=count+5` (≤ 50: the pick reads 3, brand `BRAND_VIDEOS` = 30).
  3. `videos.list?part=snippet`. No `statistics` (FR-015).
- **Gate:** identity needs the owner's profile and grant, not `artistJob`, because the channel is always the owner's own.
  - Memory, feedback and brand still need `artistJob` (AGENTS.md is updated).
  - Every pick reads identity or waits (R8), so no pick runs without it and none needs a provenance flag.
- **Quota:** 3 units per pick and 3 per brand proposal, from the OAuth client's project.
- **Policy:** Authorized Data shown only to the authorizing user (III.E.3.b). The channel is the connection's (III.E.3.e).

## R7 · Which name a pick, an approval and a Short use

- **Pick:** reads the owner's current profile when it runs (US4) and stores `Pick.artistName`.
- **Approval:** allows the pick's own `artistName`, so a rename between pick and approval can't break the draft (FR-011, SC-005).
- **Short (owner):** `createShort` keeps the parent's `artistId`, because `jobs_insert` (`drizzle/0004_tenant_rls.sql:40`) checks it through `soundboard_owns_job` (`:8`, `IS NOT DISTINCT FROM`), null included. The policy is unchanged. It sets `artistName` to the owner's current profile name and rebuilds the Short's tags:
  - drop the parent pick's `artistName` (case-insensitive) from the copied approved tags
  - put the current name first, with its length reserved (R9)
  - leave the parent's approved fields untouched
  - a legacy parent with `artistName: null` just gains the current name, and keeps `artistId: null`
- **Backfill:** R3 step 4. `null` means unknown, never a guessed name. `'Flies Like Robots'` on `flr` jobs is what the constant put in those picks.

## R8 · Identity-read outcomes (platform layer)

New `identityFailure(error)` in `platforms/youtube/youtube.ts`, used by the pick and the brand flows. A 403 is classified by its `error.errors[0].reason`, never by status alone.

| Outcome        | Inputs                                                                                                                                                                                                                                                                                                           | Pick step                 | Brand propose                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------- |
| `access-lost`  | No connected row; `accessTokenFor` → null (`invalid_grant` marks it revoked); 401; 403 `forbidden`, `insufficientPermissions`, `channelForbidden`, `playlistItemsNotAccessible`, or any other 403 reason not listed below; 404 (`channelNotFound`, `playlistNotFound`); no `mine=true` item matching the channel | wait `reconnect YouTube`  | `{ wait: 'reconnect YouTube' }`  |
| `busy`         | 403 `quotaExceeded`, `dailyLimitExceeded`, `rateLimitExceeded` or `userRateLimitExceeded`; 429; 5xx; network error; an abort; `DeadlineSpent` (R14); `accessTokenFor`'s channel-mismatch throw (a reconnect raced the read)                                                                                      | wait `waiting on YouTube` | `{ wait: 'waiting on YouTube' }` |
| `app-rejected` | Token refresh `invalid_client` or `unauthorized_client`; 403 `accessNotConfigured`; 400 `keyInvalid` or `keyExpired`; any other 400 (a malformed request is an app defect)                                                                                                                                       | throw (a failure)         | throw                            |

- `access-lost` from a live token calls `access.refused(job.id)`, which marks the grant like uploads do.
- `busy` never touches the grant.
- A wait never counts toward `consecutiveFailures` and never fails the job.
- Quota uses `waiting on YouTube`, not `limitUntil`. `limitUntil` drives `quotaHold`'s "model quota spent" on model steps, so it can't carry a YouTube limit.
- Reasons: [errors reference](https://developers.google.com/youtube/v3/docs/errors), and the `channels.list` and `playlistItems.list` error tables.

## R9 · The required artist tag

- **Reserve first:** `pickTags` (`smart-pick.ts:374-392`) adds the artist key last today, so a long name can be dropped by the 500-character loop. Count the artist tag's `tagsLength` first, then fill model picks into the rest. Deduplicated case-insensitively, kept exactly once (SC-003).
- **Exempt from the song-title rule** (`pickTags` `containsWords`, `actions.ts:48`): a self-titled song keeps the artist tag.
- **The tag editor preserves it:**
  - `Review.svelte` shows `pick.artistName` as a fixed tag outside the editable comma field.
  - The submit sends `[artistName, ...splitTags(text)]`, deduplicated case-insensitively.
  - The live counter includes it.
  - Server `finalFields` requires it exactly once. Missing → 422 `tags: "Keep the artist tag: <name>."`
- **Entry rules that keep it one tag:**
  - no comma: `splitTags` splits on commas, and Bandcamp's tags field is comma-separated
  - no leading `#`: `metadata.ts:64` rejects it as a hashtag
  - no `<` or `>`
- **YouTube:** tags total ≤ 500, commas count, and spaced tags count their quotes. No characters are documented as forbidden in tags.

## R10 · Voice, credits and the contact line

- **Curated (Nathan):** `ARTIST_VOICE` unchanged, plus the "hacked and slashed" credit-line instruction.
- **Generic (owner):** `GENERIC_VOICE`, which is `ARTIST_VOICE`'s plain-copy lines without the humor, asides and caps lines. The prompt says no credit line and no contact line, and `bandcamp.credits` is an empty string.
- **Contact line (FR-006), placed in code, deterministically:**
  - The prompt tells every run to write no contact line.
  - `finalizePick` drops every description and credits line that looks like contact information. That covers stale contacts copied from uploads or feedback. A line is dropped when it:
    - contains an email address
    - contains a phone number: `\+?\d[\d\s().-]{6,}\d`, at least 8 digits in all
    - contains a URL (`https?://` or `www.`)
    - contains an `@handle`: `(?<![\w@])@[\w.]{2,}`
    - starts with a contact label, case-insensitive: `booking`, `bookings`, `contact`, `email`, `e-mail`, `dm`, `dms`, `inquiries`, `enquiries`, `management`, `press`, optionally followed by `:` or `-`
  - **The filter is pattern-based.** It catches these forms, not every way to write a contact. The Review step is the backstop.
  - It then appends the profile's `contactLine` as the last body line, before the closing hashtags. It's reserved before `clip`, so it's never truncated.
  - It also appends it as the last line of `bandcamp.credits`.
  - Null contact means nothing is appended, so a cleared contact leaves none.
- **Unaffected:** the hashtag line, the credit line ("Written, performed, recorded, hacked and slashed by …") and ordinary prose match none of the patterns. Links from public facts don't exist after R5, so dropping URL lines removes no allowed link.
- **Wording:** `smart-pick.ts:184` "Keep his slang" → "Keep the artist's slang".
- **SC-004:** Nathan's contact text is identical. Its position is the end of the body, where his credit and contact lines sit today.

## R11 · Validation

- **Shared:** `parseArtist` in `src/lib/artist.ts` (form and server). The database repeats the rules as `CHECK`s.

| Field       | Rule                                                                                                                                                        | Message                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| name        | empty after trim                                                                                                                                            | "Add the artist name."                          |
| name        | > 100                                                                                                                                                       | "Artist names are at most 100 characters."      |
| name        | `<` or `>`                                                                                                                                                  | "Artist names can't contain < or >."            |
| name        | `,`                                                                                                                                                         | "Artist names can't contain commas."            |
| name        | starts with `#`                                                                                                                                             | "Artist names can't start with #."              |
| bandcampUrl | not `https:`, host not `<sub>.bandcamp.com` (`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.bandcamp\.com$`, lowercased), a port, credentials, or a path other than `/` | "Use your https://<name>.bandcamp.com address." |
| contactLine | > 200                                                                                                                                                       | "Contact lines are at most 200 characters."     |
| contactLine | `<` or `>`                                                                                                                                                  | "Contact lines can't contain < or >."           |
| contactLine | `#` anywhere                                                                                                                                                | "Contact lines can't contain #."                |

- **Storage:** the URL is stored normalized as `https://<sub>.bandcamp.com`. Empty optional fields become null.
- **Why `#` in contact:** the app appends the contact line verbatim, and `metadata.ts:55` rejects any hashtag not in the job's candidates. `DM #myband` would make every draft unapprovable as written.

## R12 · Bandcamp links and gate G1

- **Editor:** `${bandcampUrl}/edit_track`. Footer: `bandcampUrl`.
- **G1, signed-out part (2026-10-25, quickstart Q6):** verified. A signed-out `GET` on `<sub>.bandcamp.com/edit_track` → `303` to `bandcamp.com/login?bounce=<sub>.bandcamp.com/edit_track`, for Nathan's subdomain and for a second artist's.
- **G1, authenticated part: pending, owner to run (task T043).** Signed in as Nathan, `https://flieslikerobots.bandcamp.com/edit_track` must open his track editor. Agents may not enter his Bandcamp login.
  - It doesn't block implementation: today's hard-coded link is the same URL, so the change carries no new risk for Nathan. The PR calls the pending check out.
- **Coverage:** validation accepts only this URL class (owner), so the signed-out check covers everything accepted. Custom domains are refused.

## R13 · Retention and revocation of YouTube data

- **Developer Policies:**
  - III.E.4.c: other Authorized Data is kept "no longer than 30 calendar days", then deleted or refreshed.
  - III.D: deletion within 7 days of in-app revocation.
  - The text has no exemption for resource IDs, so IDs count as API Data.
- **Gemini:** the owner's own authorized YouTube data has gone to Gemini (paid tier) since spec 002. Google's prompt retention (up to 55 days for abuse monitoring, `store: false`) is the PRD's documented, accepted position (`docs/prd.md:220`). This spec adds no new kind of data to those calls, so no new gate.
- **Identity reads:** used in memory within one step.
  - Never written to the database: the pick stores only model output and `artistName`.
  - A test asserts a sentinel string from a fake upload description appears in no `jobs` or `artist_memory` row.
- **Model output is app output:** drafts, `brandCheck` and brand rules the artist approves are the app's own text, not stored API data. Reply and reasoning tracing stay as AGENTS.md requires.
- **Sentry:**
  - Span retention is plan-dependent: 30 days on Developer and Team, 90 days on transaction-billed Team and Business, 13 months downsampled on Business and Enterprise.
  - The org's plan is unknown (PRD Open Questions), so the retention counts as unknown.
  - **Decision:** YouTube-sourced input never reaches Sentry.
    - The pick's `recentUploads` and the brand request's `uploads` go in their own text part, tagged `source: 'youtube'`.
    - `redactTurns` (`core/tracing.ts:60`) replaces it with `{ type: 'text', content: '[YouTube uploads: <n>]' }` in both `invoke_agent` and `chat` span attributes.
    - **Re-ask:** `chatJson` (`ai/model.ts:206-222`) resends the original turns, tags included, so the re-ask's `chat` span carries the same placeholder. `sdkMessage` drops `source` before the SDK call.
    - Thumbnails are already placeholders. The model sees the full text.
    - AGENTS.md's "Keep prompt and reply text for every agent" gains this exception, and so does PRD R11.
- **Brand source IDs:** `basedOn: string[]` (`artist/brand.ts:226`, shown only as a count at `brand/+page.svelte:157`) becomes `uploadCount: number`. The migration converts stored rows (R3 step 5).
- **Revocation:**
  - Disconnect revokes and deletes the grant (`connection.ts:91-110`).
  - After that, `accessTokenFor` returns null, so identity and brand reads stop (test).
  - No other YouTube-sourced identity data is stored, so nothing else needs deleting.
- **Out of scope, noted for the owner:** genre-search evidence (Non-Authorized Data) is already kept in Sentry prompt text today (`smart-pick` `audienceTopVideos`, `candidateLists`), under the same unknown retention. The same `source: 'youtube'` tag would cover it, but that changes spec 002 and 003 behavior.

## R14 · Step deadline

- **Decision:** the step's shared 110 s `deadline` (epoch ms) bounds every read the pick and the brand proposal make. No helper starts its own fixed timer.
- **`budgetSignal(deadline)`** in `platforms/youtube/youtube.ts`:
  - remaining ≤ 0 → throws `DeadlineSpent` before any request. `AbortSignal.timeout` throws `RangeError` on a negative value, so it's never called with one.
  - otherwise → `AbortSignal.timeout(remaining)`.
- **Threaded through:**
  - `accessTokenFor(uid, channelId, deadline)`: checks first, then builds its `OAuth2Client` with `transporterOptions: { signal: budgetSignal(deadline) }`.
  - `ownUploads`: each of its 3 calls.
  - `thumbnailImage(url, deadline)`: drops its 10 s timer (`youtube.ts:217`). `DeadlineSpent` or an abort → null, as for any unreadable thumbnail.
  - `keyGet(path, query, deadline)` (`youtube.ts:59`, drops its 15 s timer), so `searchMusicVideos`, `videosByIds` and `audienceEvidence(chunks, durationSec, deadline)` (`pipeline/hashtags.ts:130`). `DeadlineSpent` or an abort in the audience read → the pick returns `waiting on YouTube`. Other audience errors keep today's handling.
- **Other `accessTokenFor` callers:** publishing and verify pass the handler's deadline from `runStep`; confirm-upload passes `stepDeadline()`. A refresh error that `identityFailure` classifies as `busy` returns `waiting on YouTube`; their other errors keep today's handling.
- **Model time is reserved:** before the model call, the pick and the brand proposal check `hasModelTime(agent, deadline)` (new in `ai/model.ts`: remaining ≥ the agent's `minCallMs`). Short → `{ wait: 'model busy' }`, no model call, no failure count. Today `chat` throws there (`model.ts:150`), which counts as a failure.
- **G2 (2026-10-25, quickstart Q8):** a real `OAuth2Client` (11.1.0) against a local token endpoint that never answers, with `transporterOptions.signal = AbortSignal.timeout(1500)`, rejected "The operation was aborted." after 1505 ms. The signal reaches the refresh request.
- **On abort:** the error classifies as `busy` (R8), so the step returns `waiting on YouTube`, and `runStep` releases the claim as for any wait.

## R15 · Missing profile at pick time

- **(Owner)** The pick step returns `'Add your artist name first.'` before any YouTube or model call. The working screen links to `/settings`. A wait never fails the job.

## R16 · Starting a job needs a profile

- `POST /api/jobs` and `POST /api/jobs/{id}/short` → `409 "Add your artist name first."`
- `jobs_insert` tightens for top-level jobs: `artist_id is not null and artist_id = <caller's>`. The Short branch is unchanged.

## R17 · Rebasing onto 003-resumable-upload

- 004 adds no `jobs` column. If 003 lands migration `0005`, delete 004's migration, snapshot and journal entry, regenerate, and paste the data block back (task T042).
- Expected conflicts:
  - `create.ts` and `new/+page.svelte`: 004 only adds a guard and a wrapping `{#if}`.
  - `playwright.config.ts` and `deploy.sh`: 004 only deletes `FLR_CHANNEL_ID`.

## R18 · Test scope

- **Unit:** the migration and backfill, RLS, the profile API, prompt and finalize (curated and generic), owner-grant reads with every R8 outcome, deadline aborts, Sentry redaction, no persistence, approval and Short rename, and the missing-profile wait.
- **E2E (both projects, Pixel 7 primary):** the first-run form, Settings edits, display for a non-Nathan user, signed-out pages, and the fixed artist tag in review.
- **Not automated:** YouTube's own tag acceptance (provider behavior), and Bandcamp's signed-in editor (the owner's check, T043).

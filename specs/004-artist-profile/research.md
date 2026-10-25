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
- **Short (owner):** `createShort` sets `artistName` to the owner's current profile name. It rebuilds the Short's tags:
  - drop the parent pick's `artistName` (case-insensitive) from the copied approved tags
  - put the current name first, with its length reserved (R9)
  - leave the parent's approved fields untouched
  - a legacy parent with `artistName: null` just gains the current name
- **Backfill:** R3 step 4. `null` means unknown, never a guessed name. `'Flies Like Robots'` on `flr` jobs is what the constant put in those picks.

## R8 · Identity-read outcomes (platform layer)

New `identityFailure(error)` in `platforms/youtube/youtube.ts`, used by the pick and the brand flows:

| Outcome        | Inputs                                                                                                                                                                                     | Pick step                           | Brand propose                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | -------------------------------- |
| `access-lost`  | No connected row; `accessTokenFor` → null (`invalid_grant` marks it revoked); YouTube 401; 403 `insufficientPermissions` or `forbidden`; no `mine=true` item matching the channel          | wait `reconnect YouTube`            | `{ wait: 'reconnect YouTube' }`  |
| `busy`         | 403 `quotaExceeded`, `rateLimitExceeded` or `userRateLimitExceeded`; 429; 5xx; network error; the deadline's abort; `accessTokenFor`'s channel-mismatch throw (a reconnect raced the read) | wait `waiting on YouTube`           | `{ wait: 'waiting on YouTube' }` |
| `app-rejected` | Token refresh `invalid_client` or `unauthorized_client`; 403 `accessNotConfigured`; any other 4xx                                                                                          | throw (a failure, constitution III) | throw                            |

- `access-lost` from a live token calls `access.refused(job.id)`, which marks the grant like uploads do.
- `busy` never touches the grant.
- A wait never counts toward `consecutiveFailures` and never fails the job.
- Quota uses `waiting on YouTube`, not `limitUntil`. `limitUntil` drives `quotaHold`'s "model quota spent" on model steps, so it can't carry a YouTube limit.

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
  - `finalizePick` strips from the model's description and credits every line that contains an email address or starts with `contact` (case-insensitive). That covers stale contacts copied from uploads or feedback.
  - It then appends the profile's `contactLine` as the last body line, before the closing hashtags. It's reserved before `clip`, so it's never truncated.
  - It also appends it as the last line of `bandcamp.credits`.
  - Null contact means nothing is appended, so a cleared contact leaves none.
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

- **Storage:** the URL is stored normalized as `https://<sub>.bandcamp.com`. Empty optional fields become null.

## R12 · Bandcamp links and gate G1

- **Editor:** `${bandcampUrl}/edit_track`. Footer: `bandcampUrl`.
- **G1 (2026-10-25, quickstart Q6):** a signed-out `GET` on `<sub>.bandcamp.com/edit_track` → `303` to `bandcamp.com/login?bounce=<sub>.bandcamp.com/edit_track`, for Nathan's subdomain and for a second artist's.
- **After sign-in:** the editor is reached by following that `bounce`. Today's feature proves this for Nathan's own account. Other accounts follow the same `bounce` URL; the app never needs another artist's login.
- **Coverage:** validation accepts only this URL class (owner), so the gate covers everything accepted. Custom domains are refused.

## R13 · Retention and revocation of YouTube data

- **Developer Policies:**
  - III.E.4.c: other Authorized Data is kept "no longer than 30 calendar days", then deleted or refreshed.
  - III.D: deletion within 7 days of in-app revocation.
  - The text has no exemption for resource IDs, so IDs count as API Data.
- **Identity reads:** used in memory within one step.
  - Never written to the database: the pick stores only model output and `artistName`.
  - A test asserts a sentinel string from a fake upload description appears in no `jobs` or `artist_memory` row.
- **Sentry:**
  - Span retention is plan-dependent: 30 days on Developer and Team, 90 days on transaction-billed Team and Business, 13 months downsampled on Business and Enterprise.
  - The org's plan is unknown (PRD Open Questions), so the retention counts as unknown.
  - **Decision:** YouTube-sourced text never reaches Sentry.
    - The pick's `recentUploads` and the brand request's `uploads` go in their own text part, tagged `source: 'youtube'`.
    - `redactTurns` (`core/tracing.ts:60`) replaces it with `{ type: 'text', content: '[YouTube uploads: <n>]' }` in both `invoke_agent` and `chat` span attributes.
    - Thumbnails are already placeholders. The model sees the full text.
    - AGENTS.md's "Keep prompt and reply text for every agent" gains this exception, and so does PRD R11.
- **Brand source IDs:** `basedOn: string[]` (`artist/brand.ts:226`, shown only as a count at `brand/+page.svelte:157`) becomes `uploadCount: number`. The migration converts stored rows (R3 step 5).
- **Revocation:**
  - Disconnect revokes and deletes the grant (`connection.ts:91-110`).
  - After that, `accessTokenFor` returns null, so identity and brand reads stop (test).
  - No other YouTube-sourced identity data is stored, so nothing else needs deleting.
- **Out of scope, noted for the owner:** genre-search evidence (Non-Authorized Data) is already kept in Sentry prompt text today (`smart-pick` `audienceTopVideos`, `candidateLists`), under the same unknown retention. The same `source: 'youtube'` tag would cover it, but that changes spec 002 and 003 behavior.

## R14 · Step deadline

- **Decision:** the step's shared 110 s `deadline` (epoch ms) is threaded through. No helper starts its own fixed timeout.
  - `accessTokenFor(uid, channelId, deadline)` builds its `OAuth2Client` with `transporterOptions: { signal: AbortSignal.timeout(Math.max(0, deadline - Date.now())) }`.
  - `ownUploads` passes `AbortSignal.timeout(remaining)` to each `fetch`.
- **Other callers:** every other `accessTokenFor` caller passes its own step deadline (`stepDeadline()` in actions). That covers publishing, verify, confirm-upload and brand.
- **G2 (2026-10-25, quickstart Q8):** a real `OAuth2Client` (11.1.0) against a local token endpoint that never answers, with `transporterOptions.signal = AbortSignal.timeout(1500)`, rejected "The operation was aborted." after 1505 ms. The signal reaches the refresh request.
- **On abort:** the error classifies as `busy` (R8), so the step returns `waiting on YouTube`, and `runStep` releases the claim as for any wait. Publishing and verify apply the same `busy` check to a refresh error; their other errors keep today's handling.

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
- **Not tested:** YouTube's own tag acceptance, and Bandcamp's post-login redirect (provider behavior).

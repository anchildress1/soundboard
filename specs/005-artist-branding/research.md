# Research: Per-artist voice and brand guide

Checked 2026-10-25 against:

- `004-artist-profile` at `7256ea4` (final plan, research, data-model, tasks, contract), the design this spec builds on:
  - `artists` table, one per user, linked by `users.artist_id`; the migration always inserts `flr` with `curated = true`
  - owner-grant reads `ownUploads(token, channelId, count, deadline)` and `accessTokenFor(uid, channelId, deadline)`
  - `identityFailure(error)` (004 R8): 403s classified by reason into `access-lost` (wait `reconnect YouTube`, grant marked refused), `busy` (wait `waiting on YouTube`, grant untouched) and `app-rejected` (an error)
  - `budgetSignal(deadline)` and `DeadlineSpent`; `hasModelTime(agent, deadline)` → `model busy` with no failure count (004 R14)
  - identity reads never stored; YouTube text parts tagged `source: 'youtube'` and replaced by `[YouTube uploads: <n>]` in spans, including the re-ask, which resends the tagged turns (004 R13)
  - generic artists get `GENERIC_VOICE` and "Write no credit line"; `finalizePick` drops contact-looking lines and appends the profile's `contactLine` (004 R10)
  - `createShort` keeps the parent's `artistId`, sets the current profile name, and leaves the parent's approved fields untouched (004 R7)
  - brand rows keep `uploadCount`, not `basedOn` (004 migration step 5)
  - constitution 3.0.0 (004 T001): temporary II and IV exceptions that name spec 005 as their removal point
- the code on `main` at `fcee227`: `src/lib/server/artist/{brand,memory}.ts`, `src/lib/brand.ts`, `src/routes/brand/`, `src/routes/api/brand/*`, `src/lib/server/ai/{smart-pick,model}.ts`, `src/lib/server/core/{schema,tracing,genre-cleanup}.ts`, `src/lib/server/platforms/youtube/connection.ts`, `src/lib/server/jobs/jobs.ts`, `src/lib/server/pipeline/short.ts`, `functions/genrecleanup.ts`
- `.specify/memory/constitution.md` v2.0.1 on `main`, and its 3.0.0 text as 004 T001 specifies, `docs/prd.md`, `AGENTS.md`, `docs/operations/youtube-retention.md`, `docs/youtube-audit/architecture.md`
- YouTube API Services [Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.D (revocation), III.E.3.b, III.E.4.b–d, III.E.4.h
- The SQL below (policies, `CHECK`, claim statements, `FOR SHARE` in PL/pgSQL) was run on PGlite 2026-10-25.

## R1 · Where voice and brand live

- **Decision:** a new table `artist_guides`. One row per artist, kind (`voice` | `brand`) and status (`proposed` | `approved`), so at most one pending proposal and one approved version each (FR-001). A small `guide_claims` table holds the proposal claim (R8). Shapes in [data-model.md](data-model.md).
- **Rationale:**
  - FR-004 needs a database-enforced expiry on proposals. That needs a real timestamp column the RLS predicate and the cleanup role can see.
  - The cleanup role today reads only `job_audience (job_id, retrieved_at)`. Giving it `artist_memory` would expose facts, feedback and publishes. A separate table keeps its grant to `(id, status, proposed_at)` of guides only.
  - Approved versions must be checkable as holding no YouTube data (R4). A `CHECK` on a dedicated table does that; a `jsonb` blob in `artist_memory` can't be constrained per kind cleanly.
- **Alternatives:**
  - Keep brand in `artist_memory` and add `voice` there, plus a `proposed_at` column: widens the cleanup role onto every memory row, and the `kind`/`key` check grows special cases. Rejected.
  - A column pair on `artists` (`voice_approved`, `voice_proposal`, …): four `jsonb` columns, and expiry can't delete a column value by policy. Rejected.
- **Brand moves out of `artist_memory`:** the migration copies the approved brand row, then deletes every `kind = 'brand'` row and drops `brand` from the `kind` enum (R3).

## R2 · Nathan's voice and brand become data, `curated` goes

- **Voice:** the migration inserts an approved `voice` row for the artist where `curated = true`, so no `flr` literal is needed in SQL.
  - `body.rules`: the 8 `ARTIST_VOICE` bullet lines, verbatim, in order, without the leading `- `.
  - **Ninth rule (owner decision Q4):** Nathan's credit wording from 004's curated credits: `His credit line in his own wording, like "Written, performed, recorded, hacked and slashed by", with the credited name exactly as in recentUploads.` Once `curated` is gone, the credit-line instruction follows the voice: an approved voice's rules decide credit lines, and no approved voice means 004's "Write no credit line". His drafts keep the credit line, and he can edit it like any rule.
  - `sources`: `{ uploads: 0, drafts: 0, edits: 0, approvals: 0, carriedOver: true }`. `proposed_at` and `approved_at`: the migration's `now()`.
- **Brand:** the migration copies `artist_memory` (`kind = 'brand'`, `key = 'approved'`) into an approved `brand` row.
  - `body`: `statement`, `keep`, `fix`, `drop` unchanged.
  - `sources`: `{ uploads: <data.uploadCount>, drafts: 0, edits: 0, approvals: 0, carriedOver: true }`. 004's migration already replaced `basedOn` with `uploadCount`.
  - `proposed_at` from `data.createdAt`, `approved_at` from `data.approvedAt`.
  - A pending brand proposal (`key = 'proposal'`) is **not** copied. It has no titles to list as sources, and it's YouTube-derived. Nathan can propose again.
- **Then:** `ALTER TABLE artists DROP COLUMN curated`. `ARTIST_VOICE`, 004's curated credit block and every `curated` reader are deleted in the same change (constitution IV, VI).
- **Rationale:** FR-009 needs no action from Nathan. SC-003 holds because his rules are byte-identical and still the only voice text in his prompt (R7).
- **Prompt header:** `ARTIST_VOICE` opens with "Write the description the way the artist writes his own:". The data holds only rules, so the header becomes code shared by every approved voice: "Write the description the way the artist writes their own:". One pronoun changes. The test asserts his 9 rules appear verbatim and in order.
- **Fail loud:** 004's migration always inserts `flr` as the one curated artist, so a fresh database has exactly one. If none has `curated = true` (a broken 004 migration), the voice insert affects 0 rows and Nathan would drop to `GENERIC_VOICE`. The migration raises when the insert count isn't exactly 1.
- **Test databases (Codex #13):** the unit helper migrates once and `truncate()` clears every row, and a fresh E2E database has no approved brand for the migration to copy. So tests seed Nathan's guides explicitly (the shared `USERS` seed and `approvedGuide()`, T015). Only the migration-replay suite (T007) asserts what the migration itself produces.

## R3 · Migration order

One generated migration, `drizzle-kit generate --name artist_guides`, numbered after 004's (and 003's, if it lands one). Before it's committed or applied anywhere, edit the generated SQL:

1. `CREATE TABLE artist_guides` and `CREATE TABLE guide_claims` (generated), with their checks, unique, FKs, policies.
2. Data block:
   1. Insert Nathan's voice from `artists WHERE curated` (R2); raise unless 1 row.
   2. Copy the approved brand row from `artist_memory` (R2), `ON CONFLICT DO NOTHING`.
   3. `DELETE FROM artist_memory WHERE kind = 'brand'`.
3. The generated `artist_memory_kind_check` change (no `brand`).
4. `ALTER TABLE artists DROP COLUMN curated` (generated from the schema change).
5. Appended: `FORCE ROW LEVEL SECURITY` on both tables, app and cleanup grants, `soundboard_save_proposal`.

Editing an unapplied migration is allowed; AGENTS.md bars editing applied ones. The data block reads `artist_memory` and `artists`, which have `FORCE ROW LEVEL SECURITY`; it relies on the migration login bypassing RLS, exactly as 004's data block and `scripts/invite.ts` (same owner credential) already do. Rebase rules match 004 R17: if numbering moves, regenerate and paste the data block back.

## R4 · YouTube retention (FR-003, FR-004, SC-004)

- **What a proposal reads:** titles, descriptions, tags and thumbnails of the artist's own uploads, through their own grant (`ownUploads`, 004 R6), at proposal time only. No `statistics` part, no comments (FR-003).
- **Not identity reads:** 004's AGENTS.md rule "NEVER store identity-read uploads (titles, descriptions, video IDs)" covers the pick's reads. Proposal reads are a different use: FR-002 requires naming the sources, so a proposal keeps a source list until it expires (below). AGENTS.md gets that scope written in (T003).
- **What is never stored:** the inputs. Descriptions, tags and thumbnails live only in the request's memory and the model call.
- **What a proposal stores:** model output (rules) and its source list. The source list holds `videoId`, `title` and `publishedAt` per upload read: Authorized Data (III.E.4.c, 30 days at most). So every proposal row expires.
- **Clock (Codex #5):** `proposed_at` is the claim's `claimed_at`: the database's `now()` when the step claims the proposal, before the first YouTube read (R8). It's never later than the earliest input retrieval, so expiry measured from it is conservative.
- **Hide at 29 days, delete daily:**
  - RLS hides a proposal once `proposed_at <= now() - interval '29 days'`. The app can't read, approve or discard it.
  - The daily `genrecleanup` function runs `DELETE FROM artist_guides WHERE status = 'proposed' AND proposed_at <= now() - interval '29 days'`, as `soundboard_cleanup`.
  - Worst schedule: a row turns 29 days old just after a run. The next run comes under 24 hours later, before the row is 30 days old.
  - `soundboard_cleanup` gets `SELECT (id, status, proposed_at)` and `DELETE` on the table, and policies limited to expired proposals.
  - The bound holds only while the job runs daily. The cleanup redeploy goes out before, or with, the app revision that serves `/api/guides/*/propose` (T032).
- **Writes:** proposals are written only by `soundboard_save_proposal` (data-model), which takes `proposed_at` from the claim and replaces an expired leftover. The app's own `INSERT` policy admits only approved rows, and only with `proposed_at` inside the last 29 days, so no row can be forward-dated past its expiry.
- **One rule:** every proposal expires the same way, including one built from Soundboard edits alone. No special case.
- **Revocation (Codex #2, III.D):**
  - Disconnect (`revokeGrant`) and a refused grant (`markRevoked`) delete the artist's proposals in the same transaction as the connection write.
  - An expired proposal is already invisible to the app; the daily job removes it within a day, inside III.D's 7 days.
  - **In-flight proposals:** `soundboard_save_proposal` takes `FOR SHARE` on the caller's `connected` connection row before saving any upload list, and raises `28000` without one. The handler answers `{ wait: 'reconnect YouTube' }` and stores nothing.
  - **Ordering:** a disconnect that lands first leaves no `connected` row, so the save refuses. A save that lands first holds the share lock. The disconnect's connection write then waits, and its proposal delete (a later statement, a fresh snapshot) removes the new row.
  - An edits-only voice proposal (no uploads) saves without the check. Disconnect still deletes it, one rule for every proposal.
- **What approval keeps:** the approved rules, as the artist's own statement (owner's stated III.E.4.h interpretation, spec 002), and a source summary of counts only: `{ uploads, drafts, edits, approvals, carriedOver }`.
- **Strict summary (Codex #4):** a `CHECK` requires an object with exactly those keys: four numbers and one boolean, never null or missing. `IS NOT DISTINCT FROM` keeps a missing key from passing as SQL `NULL`. No video ID or title persists past approval. PGlite refused `{"videoId":…}`, an extra `videoId` key, a null, a missing key, a string count and a non-object.
- **Statistics:** none fetched, none stored (FR-004). A count of uploads read is not a YouTube statistic and isn't calculated from one.
- **Sentry, inputs (004 R13):** the voice request's upload parts are tagged `source: 'youtube'`, as the brand request's already are, so `redactTurns` replaces them with `[YouTube uploads: <n>]` in every span. Soundboard edits stay in the prompt text; they aren't YouTube data. Thumbnails are already placeholders.
- **Sentry, outputs (Codex #3):** a voice or brand proposal reply restates its sources: rules quote recurring lines verbatim, and the reasoning walks the descriptions. So for `voice-guide` and `brand-guide` only, Sentry keeps no reply text:
  - The `chat` span's reply and reasoning parts become `[guide proposal: <n> chars]`.
  - So does the `invoke_agent` span's output (`agentOutput`).
  - **Re-ask:** 004's `chatJson` path resends the tagged turns. The failed reply goes back as an assistant text part tagged `source: 'guide'`, and `redactTurns` turns it into the same placeholder in the re-ask's input.
  - Prompts and system text stay recorded. The other agents keep their reply text (AGENTS.md).
  - This is a new observability exception, written into AGENTS.md and PRD R11 (T002, T003).
- **Constitution impact:** III's second exception names "expired YouTube statistics". Deleting expired proposals widens it to expired YouTube data. Recorded as an amendment (R12).

## R5 · Voice proposal inputs and limits

- **YouTube:** `ownUploads(token, channelId, VOICE_UPLOADS = 30, deadline)`, one `playlistItems` page (`maxResults` 35 ≤ 50). Each description clipped to 1,500 characters. No thumbnails (spec Assumption: thumbnails only for brand).
- **Two kinds of upload (owner decision Q3):**
  - **Written by the artist:** uploads with no matching `publish` memory row.
  - **Approved Soundboard drafts (lower weight):** uploads whose `videoId` matches one of the artist's `publish` memory rows. Soundboard drafted them, and the artist approved and published them.
  - Each kind goes in its own text part, tagged `source: 'youtube'`, under those exact headings, artist-written first.
  - The system prompt weighs drafts below the artist's own writing and edits.
  - The proposal lists both, as `uploads` and `drafts` (data-model).
  - **Accepted risk:** drafts from before 004 used Nathan's voice for every artist. The artist sees them listed as drafts before approving.
- **Soundboard:** the artist's newest 60 feedback rows (`recentFeedback(artistId, 60)`), then:
  - EDITED rows for `title` or `description`: strong. `before` is the draft, `after` is the artist's text. Each clipped to 600 characters.
  - ACCEPTED rows: weak, "approved as drafted", final title only.
  - SKIPPED and tag edits: left out. They say nothing about wording.
- **Nothing to learn from (US1 AS4):** zero usable uploads of either kind and zero EDITED rows → `409 "Nothing to learn from yet. Connect YouTube or finish a few releases first."` before any model call. Nothing is stored.
- **Thin evidence (edge case):** computed by the server, never by the model.
  - A prose description has at least 15 words after URLs and `#hashtags` are removed.
  - `thin = artistProse + strongEdits < 5`. Drafts don't count: they show Soundboard's earlier rules, not the artist's own writing.
  - When thin, the prompt caps rules at 3 and says the evidence is thin; the proposal shows "Little writing to learn from: N descriptions, M edits."
- **Limits:** `VOICE_RULES_MAX = 12`, `VOICE_RULE_MAX = 240` characters. Nathan's longest carried rule is under 200.
- **Size and cost (Argon, current prices $2 / $10 per 1M):** at the caps, about 11k tokens of descriptions + 12k of edits ≈ 24k input ≈ $0.05. Output typically 2k (≈ $0.02), capped at 8,192 (≈ $0.08). Doubles after the 2026-12-01 price change.
- **Model settings:** new agent `voice-guide`: `pickModel`, `medium` thinking, 8,192 tokens, `store: false`, `maxRetries: 0`, telemetry off, no temperature, `Output.object` (AGENTS.md). Reply and reasoning redacted in spans (R4).
- **`minCallMs`, timing gate (Codex #14):** 33,000 is the brand guide's measured p95. The voice prompt differs, so T004 measures before any dependent code is written:
  - one live `voice-guide`-shaped call at the caps (30 descriptions of 1,500 characters and 60 edits), logged in the ledger
  - **pass:** latency ≤ `minCallMs`, and the YouTube reads (≤ 15 s) + 2 × `minCallMs` ≤ 110 s, so a re-ask still fits
  - **fail:** `minCallMs` becomes the measured value rounded up to the next second. If the re-ask then doesn't fit, lower `VOICE_UPLOADS` and the edit count and measure again.
- **T004 result (2026-10-25):** 7.6 s at the caps (29,111 input and 402 output tokens, about $0.06), synthetic plain prose because the test channel has no public uploads. Pass: `minCallMs` stays 33,000, and 15 s + 2 × 33 s ≤ 110 s.
- **Prompt rules (system):**
  - Write the rules a writer needs to sound like this artist in a YouTube description: tone, sentence shape, recurring lines (quoted exactly), things the artist avoids.
  - "Written by the artist" is the artist's writing. "Approved Soundboard drafts (lower weight)" were drafted by Soundboard and approved by the artist: weigh them below the artist's own writing and edits.
  - In edits, `after` is the artist's writing and `before` is not.
  - Base every rule on the evidence. Don't invent a style it doesn't show.
  - No rules about hashtags, tags, links, contact lines, audio measurements or length: the app sets those (FR-008, 004 R10).
  - At most 12 rules, or 3 when thin.
- **Cleaning:** `stripDeep` (model numerics), trim, case-insensitive dedupe, cap count and length, as `cleanGuide` does.
- **Alternatives:** read comments (FR-003 forbids). Read all uploads with pagination (more cost and latency for little gain; 30 matches the brand guide). Include SKIPPED rows (weak, and about the whole draft). Exclude drafts (the owner chose lower weight instead). Rejected.

## R6 · Brand proposal on the owner's grant

- Unchanged prompt and limits from 004, with `requireArtist` instead of `requireCurated` (R11).
- Every upload counts the same for brand: the channel's look and titles are the artist's whatever drafted the text. `sources.uploads` lists them all; `drafts` is `[]`.
- 004's stored `uploadCount` is replaced by the `sources` list while the proposal is pending, and by counts once approved (R4).
- Same claim, grant, deadline and Sentry handling as voice (R4, R8).
- Cost: about 3k text + 10 thumbnails (≈ 1.1k tokens each at full resolution) ≈ 14k input ≈ $0.03, output ≈ $0.02 typical, $0.08 capped.

## R7 · How a pick uses them (FR-005–FR-008, SC-002, SC-003)

- **Read:** one query, `approvedGuides(artistId)` → `{ voice: VoiceRules | null, brand: BrandGuide | null }`, at pick time, only when `artistJob(job)` holds (AGENTS.md gate). Never another artist's: the query is keyed by the job's `artistId`, and RLS keys it on the caller's own link.
- **Voice block:** approved → the header "Write the description the way the artist writes their own:" then each rule as `- <rule>`. Otherwise `GENERIC_VOICE` (004). `ARTIST_VOICE` is deleted.
- **Content rules outrank the voice (FR-008):** one fixed line after the voice block, on every run: "These content rules outrank the voice rules: hashtags and tags only from candidateLists, no loudness, peak, clipping or silence figures except ffmpeg's, YouTube length limits, and facts, credits and links only from artistNotes, facts and recentUploads. Never write placeholders."
  - **Audio measurements only (Codex #11):** the line names audio figures, as `numerics.ts` strips them. Other numbers in evidence stay allowed: Nathan's rule writes "is track 3 on the album" from notes.
  - The tag, numeric, contact and length guards in `finalizePick` stay the enforcement; the line keeps the model from writing against them.
- **Credit lines:** with an approved voice, "Write a credit line only as the voice rules say, with the credited name exactly as in recentUploads", and `bandcamp.credits` is the credit line from the description. Without one, 004's "Write no credit line" and `''`.
- **Contact lines:** unchanged from 004. A voice rule that asks for a contact or booking line loses to `finalizePick`, which drops contact-looking lines and appends the profile's `contactLine`.
- **Brand:** unchanged block, now from `artist_guides`.
- **Bandcamp About:** already "in the artist voice", so it follows the same block.
- **Re-run:** a pick, so it reads the current approved versions.
- **Hook pick (Codex #7):** `buildHookRequest` gains the owner's current approved voice for its one prose field, `reason`.
  - The block reads "Write reason the way the artist writes their own:" then the rules, after the hook's own rules.
  - Then: "The rules above outrank the voice rules." The no-numbers rule for `reason` stays first.
  - With no approved voice, or when `artistJob` fails, the hook prompt is today's, with no voice block.
  - The brand guide isn't added: it's about the channel's drafts, not the choice of a window.
- **Short metadata (Codex #7, FR-007 as clarified):** `createShort` copies the parent's approved title, description and tags (`finalFields`) unchanged, as 004 R7 does. They're the parent's approved fields, so FR-011 keeps them as approved, and a guide approved since then doesn't redraft them. The Short's own hook pick reads the current voice.
- **Approval doesn't touch jobs (FR-011, SC-006):** picks store their output, not a reference to the guide. Approving changes only `artist_guides`.
- **Alternatives:** record the guide versions on each pick. Useful for audits, and spec 006 will need draft-level settings (its FR-023), but nothing in 005 reads it. Left to 006 (YAGNI).

## R8 · Page-driven proposal steps under the deadline

- `POST /api/guides/{kind}/propose` is one request, one step, like today's brand proposal (spec Assumption).
- **Claim (Codex #8, constitution III):** each step claims its (artist, kind) with the job claim's pattern before any YouTube or model work.
  - `INSERT INTO guide_claims (artist_id, kind) … ON CONFLICT DO NOTHING` makes the row once.
  - Then one conditional `UPDATE … SET claim_token = <uuid>, claimed_at = now(), claim_until = now() + interval '3 minutes' WHERE` free (`claim_until` null or past) and not quota-held (`limit_until` null or past) `RETURNING claim_token, claimed_at`.
  - **No row back:** `limit_until` in the future → `{ wait: 'model quota spent', limitUntil }`. Otherwise `409 "A proposal is already running in another tab."`.
  - **Release:** `UPDATE … SET claim_token = null, claim_until = null WHERE … AND claim_token = <token>`, in `finally`. Only the matching token releases. `soundboard_save_proposal` releases it in the same transaction as the save.
  - The 3-minute expiry outlives the 110 s deadline, so a crashed step frees the slot on its own.
  - No constitution exception: proposals use III's transactional claim.
- **Deadline:** `stepDeadline()` starts at handler entry. The same deadline goes to the claim, `accessTokenFor`, `ownUploads`, each `thumbnailImage` (brand), and `chatJson` (004 R14). No helper starts its own (AGENTS.md).
- **Model time is reserved:** after the reads, `hasModelTime(agent, deadline)` false → `{ wait: 'model busy' }`, no model call, no failure count (004 R14).
- **Budget:** 3 YouTube calls (bounded by `budgetSignal(deadline)`) + one memory query + the model call (`minCallMs`, T004) + one re-ask when time remains. Typical under 40 s.
- **Model waits:**
  - `model busy` → `{ wait }` at once, nothing stored. The page polls with `pRetry` + `POLL_BACKOFF`, as today.
  - **Quota (Codex #10):** `model quota spent` → the release also sets `limit_until = ModelQuotaSpent.until`, and the response is `{ wait: 'model quota spent', limitUntil }`. The page stops.
  - Until the reset, a propose returns the same wait from the claim, before any YouTube or Gemini call, across retries and reloads.
  - `/brand` loads `limitUntil` per kind, so a reloaded page shows the wait without a click.
- **Grant (constitution III, 004 R8 through `identityFailure`, Codex #6):**
  - Connection `connected` → read.
  - `revoked` or `missing_scopes`, or `accessTokenFor` null → `{ wait: 'reconnect YouTube' }` before any read.
  - A read error goes through `identityFailure(error)`:
    - `access-lost` (401; 403 `forbidden`, `insufficientPermissions`, `channelForbidden`, `playlistItemsNotAccessible` or another unlisted reason; 404) → `access.refused` marks the grant, then `{ wait: 'reconnect YouTube' }`. Proposals have no job: `refused` takes the guide kind for its Sentry tag in place of a job ID.
    - `busy` (403 `quotaExceeded`, `dailyLimitExceeded`, `rateLimitExceeded`, `userRateLimitExceeded`; 429; 5xx; network; abort; `DeadlineSpent`; channel mismatch) → `{ wait: 'waiting on YouTube' }`. The grant is untouched.
    - `app-rejected` → an error, as in 004.
  - No connection row, or `no_channel`:
    - voice proposes from Soundboard edits alone, since it doesn't need the grant (US1 AS4 allows it); with no edits either, the US1 AS4 409.
    - brand needs the grant, so it returns `{ wait: 'reconnect YouTube' }` like a revoked one. Constitution III: a missing user grant returns a wait reason immediately. If 004 still answers `409 "Connect YouTube to read your channel."` here, this replaces it; one grant path for every case.
  - Disconnected mid-step: the save refuses (R4), and the step returns `{ wait: 'reconnect YouTube' }`.
  - The page treats `reconnect YouTube` like `model quota spent`: it stops polling and shows the wait text with a link to Connections.
- **Two tabs proposing at once:** the second claim finds the slot taken and gets the 409. The Propose button also disables while a call runs. A tab that loses a proposal to a later one gets the R9 404 on approve.

## R9 · The two-tab approval race

- **Rule:** every approve and discard names the proposal row it acts on (`proposalId`, the row's identity). In one transaction:
  1. `SELECT … FOR UPDATE` the pending row for that artist and kind.
  2. Missing, expired, another artist's (invisible under RLS) or a different `id` → `404 "The guide changed in another tab. Reload to see it."`, nothing written (Codex #9). No cross-tenant lookup is made.
  3. Approve: upsert the approved row (named columns only, R10), delete the proposal. Discard: delete the proposal.
- **Outcome:** the latest approval to commit is the active version. A second approval of the same proposal waits on the row lock, then finds it gone and gets the 404, so the losing tab is told the guide changed (spec edge case). An approval of a proposal another tab replaced gets the same 404.
- **Why 404:** FR-010 and constitution I answer another user's object with a not-found, never a 403 or a 409. A stale ID and a foreign ID look the same, so nothing leaks.
- **The losing tab keeps its text:** the page leaves the edited fields in place beside the message, so nothing typed is lost.
- **Replaces** today's `proposedAt` timestamp match: two proposals can share a millisecond, row identities can't.
- **Tests:** PGlite runs one connection, so true concurrency can't be shown there. Sequential tests prove each branch: approve then approve, approve then discard, propose then approve the old ID. The row lock is standard Postgres.
- **Ambiguity:** if "latest approval wins" means the second tab's edits should overwrite the first tab's approval of the same proposal, this design is wrong. Open question Q1 (default stands).

## R10 · Where spec 006's sliders attach (FR-012)

- **Decision for 005:** nothing is added (YAGNI). The approved `brand` row is the attach point:
  - The approved row is one row per artist (`unique (artist_id, kind, status)`) and survives re-approval. Approve updates only `body`, `sources`, `proposed_at` and `approved_at` (`ON CONFLICT … DO UPDATE SET` those four), so a column 006 adds is never reset by a new approval.
  - 006 adds a nullable `influence jsonb` column, `CHECK (influence is null or (kind = 'brand' and status = 'approved'))`, and its own write path.
- **Gap:** 006 FR-021 says the defaults work without setup and FR-023 saves changes "with their brand guide". An artist with no approved brand guide has no row to save sliders on. Open question Q2, for 006's plan.

## R11 · Brand page for every artist (FR-010)

- `/brand` and `/api/guides/*` need a profile: `requireArtist(user)` in `src/lib/server/artist/profile.ts` → 404 unless `user.artist` is set. It replaces 004's `requireCurated`.
- A `proposalId` belonging to another artist is invisible under RLS, so approve and discard answer the same 404 as a stale tab (R9). Nothing about the other artist leaks.
- Every query is keyed by `user.artist.id`, and RLS checks the caller's link on `artist_guides.artist_id` and `guide_claims.artist_id`, so another user's guides are unreachable (404 on page and API, never 403).
- **Menu:** "Brand" for every user with a profile (004 showed it only for `curated`).
- **Page:** two sections, Voice and Brand guide. Each shows the approved version (or "Not set: drafts use plain, generic rules" / "Not set: drafts run without one"), then the proposal with its sources and edit form.
- **Routes:** `/api/guides/[kind=guide]/{propose,approve,discard}` with a param matcher for `voice | brand`. The old `/api/brand/*` routes are deleted with no alias (constitution VI).

## R12 · PRD, AGENTS.md and constitution (FR-013)

- **Constitution amendment (v3.0.0 → 4.0.0, MAJOR, via `/speckit-constitution`):**
  - Remove 004's two temporary exceptions: II ("Until spec 005 ships, artists without a curated profile get generic voice rules") and IV ("Until spec 005 ships, Nathan's `ARTIST_VOICE` and credit wording stay in `smart-pick.ts`…"). Both name spec 005 as their removal point.
  - II voice bullet → "Description voice MUST follow the owner's approved voice: proposed from their own writing (their YouTube descriptions and Soundboard edits), then edited and approved by them. Without an approved voice, drafts use generic plain-copy rules, never another artist's voice." The peer-influence exception and the copied-phrase ban stay.
  - III second exception → "One scheduled database retention job deletes expired YouTube data: statistics, and the inputs listed on voice and brand proposals."
  - Platform Terms gains → "YouTube data read for a proposal MUST be kept at most 30 days, enforced by the database. Only artist-approved rules, holding no YouTube data, persist."
  - III's claim rule is unchanged: proposals take a transactional claim (R8), so no new exception.
  - **Why MAJOR:** governance says MAJOR for redefined principles. II's voice MUST is redefined (approval-based, with a permanent generic fallback), and III's exception list changes scope. 004 R0 already classified this removal as MAJOR, on the `cef38f2` precedent (exceptions redefine a MUST). If the constitution isn't at 3.0.0 when this lands, take the next MAJOR. Owner confirms in the PR.
  - The amendment must land before code that relies on it, in the same PR, first commit.
- **AGENTS.md:** exact edits in T003.
- **PRD:** R4 voice (line 100) and Bandcamp voice (105); R11 observability (Sentry reply exception); R12 (194); Non-goals (45); Observability agent list (185); Platforms model row (216); data table (240); UX header menu (254). Exact edits in T002.
- **Other docs:** `docs/operations/youtube-retention.md` (second delete, 29-day bound, deploy order), `docs/youtube-audit/architecture.md` (proposal reads, expiry, revocation; approved rules as the artist's statement), `README.md` brand section, the privacy page.

## R13 · Test scope

- **Unit (PGlite, real migrations; Sentry global mock; `fetch` mocked for YouTube and Gemini):**
  - migration replay: Nathan's voice row equals the 9 rules, his brand copied without video IDs, no `brand` memory rows, no `curated` column; a 0-curated database makes the migration raise
  - RLS under `soundboard_app`: cross-artist SELECT, INSERT, UPDATE and DELETE on both tables refused or 0 rows; a proposal at 29 days invisible and not approvable; forward-dated insert refused; every `sources` bypass refused (`CHECK`); cleanup role sees and deletes only expired proposals, with the 29-day boundary
  - claims: one holder per (artist, kind), release only by token, quota hold, expiry
  - voice and brand propose/approve/discard: positive, 404s, 409s, waits by `identityFailure` reason, thin evidence, drafts labeled and listed, deadline threading, `hasModelTime`, no statistics requested, disconnect mid-step, Sentry sentinels in every span
  - pick prompt: approved voice for owner, `GENERIC_VOICE` without one, never another artist's, content-rules line present, Nathan's rules verbatim, hook voice, Short inheritance
  - approve changes no job row in `REVIEW`, `PUBLISHING`, `CLAIMED_COMPLETE` or `VERIFIED` (FR-011)
- **E2E (both projects, Pixel 7 primary):** the brand page for a non-Nathan user (own sections, model-busy wait), Nathan sees both approved, another user's guide unreachable, the race message.
- **Not tested:** Gemini's rule quality (SC-005 is a post-release check with the artist), YouTube's own playlist behavior.

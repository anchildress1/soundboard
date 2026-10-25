# Research: Per-artist voice and brand guide

Checked 2026-10-25 against:

- `004-artist-profile` at `0a9176e` (revised plan, research, data-model, tasks, contract), the design this spec builds on:
  - `artists` table, one per user, linked by `users.artist_id`
  - the migration-only `artists.curated` flag on Nathan's profile
  - the pick **waits** on `reconnect YouTube` when the owner's grant is missing or revoked
  - owner-grant reads `ownUploads(token, channelId, count, deadline)`; identity reads never stored; YouTube text parts tagged `source: 'youtube'` and replaced by `[YouTube uploads: <n>]` in spans (004 R13)
  - generic artists get `GENERIC_VOICE` and "Write no credit line"; the app appends the contact line (004 R10)
  - brand rows keep `uploadCount`, not `basedOn` (004 migration step 5)
  - constitution 3.0.0 (004 T001): temporary II and IV exceptions that name spec 005 as their removal point
  - `GENERIC_VOICE` for artists without their own voice
  - the shared 110 s step deadline threaded through YouTube reads
- the code on `main` at `fcee227`: `src/lib/server/artist/{brand,memory}.ts`, `src/lib/brand.ts`, `src/routes/brand/`, `src/routes/api/brand/*`, `src/lib/server/ai/{smart-pick,model}.ts`, `src/lib/server/core/{schema,genre-cleanup}.ts`, `functions/genrecleanup.ts`
- `.specify/memory/constitution.md` v2.0.1 on `main`, and its 3.0.0 text as 004 T001 specifies, `docs/prd.md`, `AGENTS.md`, `docs/operations/youtube-retention.md`, `docs/youtube-audit/architecture.md`
- YouTube API Services [Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.E.3.b, III.E.4.b–d, III.E.4.h

## R1 · Where voice and brand live

- **Decision:** a new table `artist_guides`. One row per artist, kind (`voice` | `brand`) and status (`proposed` | `approved`), so at most one pending proposal and one approved version each (FR-001). Shape in [data-model.md](data-model.md).
- **Rationale:**
  - FR-004 needs a database-enforced 30-day expiry on proposals. That needs a real timestamp column the RLS predicate and the cleanup role can see.
  - The cleanup role today reads only `job_audience (job_id, retrieved_at)`. Giving it `artist_memory` would expose facts, feedback and publishes. A separate table keeps its grant to `(id, status, proposed_at)` of guides only.
  - Approved versions must be checkable as holding no YouTube data (R4). A `CHECK` on a dedicated table does that; a `jsonb` blob in `artist_memory` can't be constrained per kind cleanly.
- **Alternatives:**
  - Keep brand in `artist_memory` and add `voice` there, plus a `proposed_at` column: widens the cleanup role onto every memory row, and the `kind`/`key` check grows special cases. Rejected.
  - A column pair on `artists` (`voice_approved`, `voice_proposal`, …): four `jsonb` columns, and expiry can't delete a column value by policy. Rejected.
- **Brand moves out of `artist_memory`:** the migration copies the approved brand row, then deletes every `kind = 'brand'` row and drops `brand` from the `kind` enum (R3).

## R2 · Nathan's voice and brand become data, `curated` goes

- **Voice:** the migration inserts an approved `voice` row for the artist where `curated = true`, so no `flr` literal is needed in SQL.
  - `body.rules`: the 8 `ARTIST_VOICE` bullet lines, verbatim, in order, without the leading `- `.
  - Plus one rule carrying Nathan's credit wording from 004's curated credits: `His credit line in his own wording, like "Written, performed, recorded, hacked and slashed by", with the credited name exactly as in recentUploads.` 004's `curated` selected both the voice and this credit wording. Once `curated` is gone, the credit-line instruction follows the voice: an approved voice's rules decide credit lines, and no approved voice means 004's "Write no credit line". His example wording survives as his own rule, so his drafts keep the credit line (open question Q4).
  - `sources`: `{ uploads: 0, edits: 0, approvals: 0, carriedOver: true }`. `proposed_at` and `approved_at`: the migration's `now()`.
- **Brand:** the migration copies `artist_memory` (`kind = 'brand'`, `key = 'approved'`) into an approved `brand` row.
  - `body`: `statement`, `keep`, `fix`, `drop` unchanged.
  - `sources`: `{ uploads: <data.uploadCount>, edits: 0, approvals: 0, carriedOver: true }`. 004's migration already replaced `basedOn` with `uploadCount`.
  - `proposed_at` from `data.createdAt`, `approved_at` from `data.approvedAt`.
  - A pending brand proposal (`key = 'proposal'`) is **not** copied. It has no titles to list as sources, and it's YouTube-derived. Nathan can propose again.
- **Then:** `ALTER TABLE artists DROP COLUMN curated`. `ARTIST_VOICE`, 004's curated credit block and every `curated` reader are deleted in the same change (constitution IV, VI).
- **Rationale:** FR-009 needs no action from Nathan. SC-003 holds because his rules are byte-identical and still the only voice text in his prompt (R7).
- **Prompt header:** `ARTIST_VOICE` opens with "Write the description the way the artist writes his own:". The data holds only rules, so the header becomes code shared by every approved voice: "Write the description the way the artist writes their own:". One pronoun changes. The test asserts his 8 rules plus the credit rule appear verbatim and in order.
- **Fail loud:** if no artist has `curated = true` (a broken 004 migration), the voice insert affects 0 rows and Nathan would drop to `GENERIC_VOICE`. The migration raises when the insert count isn't exactly 1.

## R3 · Migration order

One generated migration, `drizzle-kit generate --name artist_guides`, numbered after 004's (and 003's, if it lands one). Before it's committed or applied anywhere, edit the generated SQL:

1. `CREATE TABLE artist_guides` (generated), with its checks, unique, FK, policies.
2. Data block:
   1. Insert Nathan's voice from `artists WHERE curated` (R2); raise unless 1 row.
   2. Copy the approved brand row from `artist_memory` (R2), `ON CONFLICT DO NOTHING`.
   3. `DELETE FROM artist_memory WHERE kind = 'brand'`.
3. The generated `artist_memory_kind_check` change (no `brand`).
4. `ALTER TABLE artists DROP COLUMN curated` (generated from the schema change).
5. Appended: `FORCE ROW LEVEL SECURITY`, app and cleanup grants, `soundboard_save_proposal`.

Editing an unapplied migration is allowed; AGENTS.md bars editing applied ones. The data block reads `artist_memory` and `artists`, which have `FORCE ROW LEVEL SECURITY`; it relies on the migration login bypassing RLS, exactly as 004's data block and `scripts/invite.ts` (same owner credential) already do. Rebase rules match 004 R15: if numbering moves, regenerate and paste the data block back.

## R4 · YouTube retention (FR-003, FR-004, SC-004)

- **What a proposal reads:** titles, descriptions, tags and thumbnails of the artist's own uploads, through their own grant (`ownUploads`, 004 R6), at proposal time only. No `statistics` part, no comments (FR-003).
- **Not identity reads:** 004's AGENTS.md rule "NEVER store identity-read uploads (titles, descriptions, video IDs)" covers the pick's reads. Proposal reads are a different use: FR-002 requires naming the sources, so a proposal keeps a source list for at most 30 days (below). AGENTS.md gets that scope written in (T003).
- **What is never stored:** the inputs. Descriptions, tags and thumbnails live only in the request's memory and the model call.
- **What a proposal stores:** model output (rules) and its source list. The source list holds `videoId`, `title` and `publishedAt` per upload read: Authorized Data (III.E.4.c, 30 days at most). So every proposal row expires.
- **Enforcement, like `job_audience`:**
  - RLS hides a proposal once `proposed_at <= now() - interval '30 days'`. The app can't read, approve or discard it.
  - Proposals are written only by `soundboard_save_proposal` (data-model), which sets `proposed_at = now()` from the database clock and replaces an expired leftover. The app's own `INSERT` policy admits only approved rows, and only with `proposed_at` inside the last 30 days, so no row can be forward-dated past its expiry.
  - The daily `genrecleanup` function also runs `DELETE FROM artist_guides WHERE status = 'proposed' AND proposed_at <= now() - interval '30 days'`, as `soundboard_cleanup`. That role gets `SELECT (id, status, proposed_at)` and `DELETE` on the table, and policies limited to expired proposals.
  - Every proposal expires the same way, including one built from Soundboard edits alone. One rule, no special case.
- **What approval keeps:** the approved rules, as the artist's own statement (owner's stated III.E.4.h interpretation, spec 002), and a source summary of counts only: `{ uploads, edits, approvals, carriedOver }`. A `CHECK` rejects an approved row whose `sources.uploads` isn't a number, so no video ID or title can persist past approval.
- **Statistics:** none fetched, none stored (FR-004). A count of uploads read is not a YouTube statistic and isn't calculated from one.
- **Sentry (004 R13):** the voice request's `uploads` text part is tagged `source: 'youtube'`, as the brand request's already is, so `redactTurns` replaces it with `[YouTube uploads: <n>]` in every span. Soundboard edits stay in the prompt text; they aren't YouTube data. Thumbnails are already placeholders. The reply (the proposed rules) is kept, like every agent's reply.
- **Constitution impact:** III's second exception names "expired YouTube statistics". Deleting expired proposals widens it to expired YouTube data. Recorded as an amendment (R12).

## R5 · Voice proposal inputs and limits

- **YouTube:** `ownUploads(token, channelId, VOICE_UPLOADS = 30, deadline)`, one `playlistItems` page (`maxResults` 35 ≤ 50).
  - Uploads whose `videoId` matches one of the artist's `publish` memory rows are left out: Soundboard drafted those descriptions, so they'd teach the model its own copy. The artist's real changes to those drafts are already in the EDITED feedback (open question Q3).
  - Each description clipped to 1,500 characters. No thumbnails (spec Assumption: thumbnails only for brand).
- **Soundboard:** the artist's newest 60 feedback rows (`recentFeedback(artistId, 60)`), then:
  - EDITED rows for `title` or `description`: strong. `before` is the draft, `after` is the artist's text. Each clipped to 600 characters.
  - ACCEPTED rows: weak, "approved as drafted", final title only.
  - SKIPPED and tag edits: left out. They say nothing about wording.
- **Nothing to learn from (US1 AS4):** zero usable uploads and zero EDITED rows → `409 "Nothing to learn from yet. Connect YouTube or finish a few releases first."` before any model call. Nothing is stored.
- **Thin evidence (edge case):** computed by the server, never by the model.
  - A prose description has at least 15 words after URLs and `#hashtags` are removed.
  - `thin = proseDescriptions + strongEdits < 5`.
  - When thin, the prompt caps rules at 3 and says the evidence is thin; the proposal shows "Little writing to learn from: N descriptions, M edits."
- **Limits:** `VOICE_RULES_MAX = 12`, `VOICE_RULE_MAX = 240` characters. Nathan's longest carried rule is under 200.
- **Size and cost (Argon, current prices $2 / $10 per 1M):** about 11k tokens of descriptions + 12k of edits ≈ 24k input ≈ $0.05. Output typically 2k (≈ $0.02), capped at 8,192 (≈ $0.08). Doubles after the 2026-12-01 price change.
- **Model settings:** new agent `voice-guide`: `pickModel`, `medium` thinking, 8,192 tokens, `minCallMs` 33,000 (the brand guide's G1 value; recorded in the live run, raised if exceeded). `store: false`, `maxRetries: 0`, telemetry off, no temperature, `Output.object` (AGENTS.md).
- **Prompt rules (system):**
  - Write the rules a writer needs to sound like this artist in a YouTube description: tone, sentence shape, recurring lines (quoted exactly), things the artist avoids.
  - In edits, `after` is the artist's writing and `before` is not.
  - Base every rule on the evidence. Don't invent a style it doesn't show.
  - No rules about hashtags, tags, links, numbers or length: the app sets those (FR-008).
  - At most 12 rules, or 3 when thin.
- **Cleaning:** `stripDeep` (model numerics), trim, case-insensitive dedupe, cap count and length, as `cleanGuide` does.
- **Alternatives:** read comments (FR-003 forbids). Read all uploads with pagination (more cost and latency for little gain; 30 matches the brand guide). Include SKIPPED rows (weak, and about the whole draft). Rejected.

## R6 · Brand proposal on the owner's grant

- Unchanged prompt and limits from 004, with `requireArtist` instead of `requireCurated` (R11).
- 004's stored `uploadCount` is replaced by the `sources` list while the proposal is pending, and by counts once approved (R4).
- Cost: about 3k text + 10 thumbnails (≈ 1.1k tokens each at full resolution) ≈ 14k input ≈ $0.03, output ≈ $0.02 typical, $0.08 capped.

## R7 · How a pick uses them (FR-005–FR-008, SC-002, SC-003)

- **Read:** one query, `approvedGuides(artistId)` → `{ voice: VoiceRules | null, brand: BrandGuide | null }`, at pick time, only when `artistJob(job)` holds (AGENTS.md gate). Never another artist's: the query is keyed by the job's `artistId`, and RLS keys it on the caller's own link.
- **Voice block:** approved → the header "Write the description the way the artist writes their own:" then each rule as `- <rule>`. Otherwise `GENERIC_VOICE` (004). `ARTIST_VOICE` is deleted.
- **Content rules outrank the voice (FR-008):** one fixed line after the voice block, on every run: "These content rules outrank the voice rules: hashtags and tags only from candidateLists, no numbers except ffmpeg's, YouTube length limits, and facts, credits and links only from artistNotes, facts and recentUploads. Never write placeholders." The tag, numeric and length guards in `finalizePick` stay the enforcement; the line keeps the model from writing against them.
- **Credit lines:** with an approved voice, "Write a credit line only as the voice rules say, with the credited name exactly as in recentUploads", and `bandcamp.credits` is the credit line from the description. Without one, 004's "Write no credit line" and `''`. The app still appends the contact line (004 R10).
- **Brand:** unchanged block, now from `artist_guides`.
- **Bandcamp About:** already "in the artist voice", so it follows the same block.
- **Re-run and Short:** a re-run is a pick, so it reads the current approved versions. A Short copies its parent's fields (`createShort`) and the hook prompt writes no prose, so neither carries a voice; a test asserts the hook prompt has no voice block (FR-007).
- **Approval doesn't touch jobs (FR-011, SC-006):** picks store their output, not a reference to the guide. Approving changes only `artist_guides`.
- **Alternatives:** record the guide versions on each pick. Useful for audits, and spec 006 will need draft-level settings (its FR-023), but nothing in 005 reads it. Left to 006 (YAGNI).

## R8 · Page-driven proposal steps under the deadline

- `POST /api/guides/{kind}/propose` is one request, one step, like today's brand proposal (spec Assumption). No claim row: it touches no job.
- `stepDeadline()` starts at handler entry. The same deadline goes to `accessTokenFor`, `ownUploads`, each `thumbnailImage` (brand), and `chatJson` (004 R14). No helper starts its own (AGENTS.md).
- Budget: 3 YouTube calls (15 s timeout each, bounded by the deadline) + one memory query + the model call (`minCallMs` 33 s). Typical under 40 s.
- `model busy` / `model quota spent` → `{ wait }` at once, nothing stored; the page polls on busy and stops on quota, as today (`pRetry` + `POLL_BACKOFF`).
- **Grant (constitution III, 004's wait design):**
  - Connection `connected` → read. A 401/403 (`uploadFailure` → `access-lost`) marks the connection refused and returns `{ wait: 'reconnect YouTube' }`.
  - `revoked` or `missing_scopes`, or `accessTokenFor` null → `{ wait: 'reconnect YouTube' }` before any read.
  - No connection row, or `no_channel`:
    - voice proposes from Soundboard edits alone, since it doesn't need the grant (US1 AS4 allows it); with no edits either, the US1 AS4 409.
    - brand needs the grant, so it returns `{ wait: 'reconnect YouTube' }` like a revoked one. Constitution III: a missing user grant returns a wait reason immediately. If 004 still answers `409 "Connect YouTube to read your channel."` here, this replaces it; one grant path for every case.
  - YouTube busy (004's `busy` mapping) → `{ wait: 'waiting on YouTube' }`, polled like `model busy`. `app-rejected` → an error, as in 004.
  - The page treats `reconnect YouTube` like `model quota spent`: it stops polling and shows the wait text with a link to Connections.
- **Two tabs proposing at once:** both calls run, and the later write replaces the earlier proposal. `soundboard_save_proposal` locks the caller's `users` row only for the write, never across the model call, so the two saves serialize and neither hits a unique violation. The first tab's approve then gets the 409 in R9. The Propose button disables while a call runs.

## R9 · The two-tab approval race

- **Rule:** every approve and discard names the proposal row it acts on (`proposalId`, the row's identity). In one transaction:
  1. `SELECT … FOR UPDATE` the pending row for that artist and kind.
  2. Missing, or a different `id` → `409 "The guide changed in another tab. Reload to see it."`, nothing written.
  3. Approve: upsert the approved row (named columns only, R10), delete the proposal. Discard: delete the proposal.
- **Outcome:** the latest approval to commit is the active version. A second approval of the same proposal waits on the row lock, then finds it gone and gets the 409, so the losing tab is told the guide changed (spec edge case). An approval of a proposal another tab replaced gets the same 409.
- **The losing tab keeps its text:** the page leaves the edited fields in place beside the message, so nothing typed is lost.
- **Replaces** today's `proposedAt` timestamp match: two proposals can share a millisecond, row identities can't.
- **Tests:** PGlite runs one connection, so true concurrency can't be shown there. Sequential tests prove each branch: approve then approve, approve then discard, propose then approve the old ID. The row lock is standard Postgres.
- **Ambiguity:** if "latest approval wins" means the second tab's edits should overwrite the first tab's approval of the same proposal, this design is wrong. Open question Q1.

## R10 · Where spec 006's sliders attach (FR-012)

- **Decision for 005:** nothing is added (YAGNI). The approved `brand` row is the attach point:
  - The approved row is one row per artist (`unique (artist_id, kind, status)`) and survives re-approval. Approve updates only `body`, `sources`, `proposed_at` and `approved_at` (`ON CONFLICT … DO UPDATE SET` those four), so a column 006 adds is never reset by a new approval.
  - 006 adds a nullable `influence jsonb` column, `CHECK (influence is null or (kind = 'brand' and status = 'approved'))`, and its own write path.
- **Gap:** 006 FR-021 says the defaults work without setup and FR-023 saves changes "with their brand guide". An artist with no approved brand guide has no row to save sliders on. Open question Q2 for 006's plan.

## R11 · Brand page for every artist (FR-010)

- `/brand` and `/api/guides/*` need a profile: `requireArtist(user)` in `src/lib/server/artist/profile.ts` → 404 unless `user.artist` is set. It replaces 004's `requireCurated`.
- A `proposalId` belonging to another artist is invisible under RLS, so approve and discard answer the same 409 as a stale tab. Nothing about the other artist leaks, and no 403 is ever sent.
- Every query is keyed by `user.artist.id`, and RLS checks the caller's link, so another user's guides are unreachable (404 on page and API, never 403).
- **Menu:** "Brand" for every user with a profile (004 showed it only for `curated`).
- **Page:** two sections, Voice and Brand guide. Each shows the approved version (or "Not set: drafts use plain, generic rules" / "Not set: drafts run without one"), then the proposal with its sources and edit form.
- **Routes:** `/api/guides/[kind=guide]/{propose,approve,discard}` with a param matcher for `voice | brand`. The old `/api/brand/*` routes are deleted with no alias (constitution VI).

## R12 · PRD, AGENTS.md and constitution (FR-013)

- **Constitution amendment (v3.0.0 → 4.0.0, MAJOR, via `/speckit-constitution`):**
  - Remove 004's two temporary exceptions: II ("Until spec 005 ships, artists without a curated profile get generic voice rules") and IV ("Until spec 005 ships, Nathan's `ARTIST_VOICE` and credit wording stay in `smart-pick.ts`…"). Both name spec 005 as their removal point.
  - II voice bullet → "Description voice MUST follow the owner's approved voice: proposed from their own writing (their YouTube descriptions and Soundboard edits), then edited and approved by them. Without an approved voice, drafts use generic plain-copy rules, never another artist's voice." The peer-influence exception and the copied-phrase ban stay.
  - III second exception → "One scheduled database retention job deletes expired YouTube data: statistics, and the inputs listed on voice and brand proposals."
  - Platform Terms gains → "YouTube data read for a proposal MUST be kept at most 30 days, enforced by the database. Only artist-approved rules, holding no YouTube data, persist."
  - **Why MAJOR:** governance says MAJOR for redefined principles. II's voice MUST is redefined (approval-based, with a permanent generic fallback), and III's exception list changes scope. 004 R0 already classified this removal as MAJOR, on the `cef38f2` precedent (exceptions redefine a MUST). If the constitution isn't at 3.0.0 when this lands, take the next MAJOR. Owner confirms in the PR.
  - The amendment must land before code that relies on it, in the same PR, first commit.
- **AGENTS.md:**
  - Content: the `ARTIST_VOICE` line → "Description voice: the owner's approved voice from `artist_guides`; without one, `GENERIC_VOICE` in `src/lib/server/ai/smart-pick.ts`. NEVER put an artist's voice in code."
  - Data and access: `/brand` opens for any user with a profile; guides keyed by `users.artist_id`.
  - YouTube terms: "Proposals expire after 30 days and are deleted daily. Approved guides hold no video IDs or titles."
  - Architecture exceptions: the retention job deletes expired YouTube data (statistics and proposals).
  - Model calls: add `voice-guide` `medium`, 8192 tokens.
- **PRD:** R4 voice (line 100) and Bandcamp voice (105); R12 (194); Non-goals (45); Observability agent list (185); Platforms model row (216); data table (240); UX header menu (254). Exact edits in tasks T001.
- **Other docs:** `docs/operations/youtube-retention.md` (second delete), `docs/youtube-audit/architecture.md` (proposal reads and 30-day expiry; approved rules as the artist's statement), `README.md` brand section, the privacy page.

## R13 · Test scope

- **Unit (PGlite, real migrations; Sentry global mock; `fetch` mocked for YouTube and Gemini):**
  - migration: Nathan's voice row equals the 8 rules + credit rule, his brand copied without video IDs, no `brand` memory rows, no `curated` column; a 0-curated database makes the migration raise
  - RLS: own guides only; expired proposal invisible and not approvable; forward-dated insert refused; approved row with an upload list refused (`CHECK`); cleanup role sees and deletes only expired proposals
  - voice and brand propose/approve/discard: positive, 409s, waits, thin evidence, Soundboard uploads excluded, deadline threading, no statistics requested
  - pick prompt: approved voice for owner, `GENERIC_VOICE` without one, never another artist's, content-rules line present, Nathan's rules verbatim
  - approve changes no job row (FR-011)
- **E2E (both projects, Pixel 7 primary):** the brand page for a non-Nathan user (own sections, model-busy wait), Nathan sees both approved, another user's guide unreachable, the race 409 message.
- **Not tested:** Gemini's rule quality (SC-005 is a post-release check with the artist), YouTube's own playlist behavior.

# Research: Artist profile inputs and display

Checked 2026-10-25 against:

- the code on `main` at `fcee227` (every file:line in [plan.md](plan.md#hard-coded-inventory))
- migration `drizzle/0004_tenant_rls.sql` (RLS, grants, `soundboard_admit`, `soundboard_owns_job`)
- YouTube Data API reference, [`videos` resource](https://developers.google.com/youtube/v3/docs/videos) (`snippet.tags`, `snippet.description`)
- YouTube API Services [Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.E.3 and III.E.4

## R1 · Where the profile lives

- **Decision:** a new `artists` table. `users.artist_id` stays the link and gains a foreign key to `artists.id` and a unique constraint.
  - One column per user means at most one profile per account (FR-001).
  - Unique means no profile is ever shared (FR-001).
  - Nathan's row keeps the ID `flr` (spec, Key Entities).
- **Rationale:**
  - Every existing policy already keys on `users.artist_id`: `memory_artist`, `jobs_insert`, `soundboard_owns_job`. They keep working unchanged.
  - `artistJob`'s "job and owner both linked" check keeps its meaning. It just stops comparing against a constant.
- **Alternatives:**
  - `artists.owner_uid` with `users.artist_id` dropped: every policy and `artistJob` would be rewritten. It also can't seed Nathan's profile when his `users` row has no `uid` yet. Rejected.
  - Profile columns on `users`: the app has no `UPDATE` on `users` (R10 bars ordinary queries from changing activation, artist assignment or bindings). Widening that grant to three columns mixes the allowlist with profile data. Rejected.

## R2 · Creating and editing a profile

- **Create:** one `SECURITY DEFINER` function, `soundboard_create_artist(p_name, p_bandcamp, p_contact)`.
  - Locks the caller's active `users` row (`app.user_sub`) `FOR UPDATE`.
  - Refuses when the row already has an `artist_id`.
  - Inserts the `artists` row with a random ID (`gen_random_uuid()::text`) and sets `users.artist_id`, all in one transaction.
  - Two tabs saving at once: the second sees the link under the lock and gets "already has a profile", which the app turns into an update (see the contract).
- **Edit:** a plain `UPDATE` on `artists` through RLS. The app gets `UPDATE (name, bandcamp_url, contact_line, updated_at)` only, and never `curated` (R4) or `id`.
- **Rationale:** artist assignment stays out of reach of ordinary app queries (PRD R10). The only new path is "claim one new profile for myself, once." That mirrors how `soundboard_admit` binds `uid`.
- **Alternatives:** a `GRANT UPDATE (artist_id) ON users` with an RLS check. The check can't express "only from null to a profile I just created." Rejected.

## R3 · Migrating Nathan's profile

- **Decision:** one migration, `drizzle-kit generate --name artist_profiles`. Before the migration is committed or applied anywhere, a data block goes between `CREATE TABLE artists` and the foreign keys. Editing an unapplied migration is allowed; AGENTS.md bars editing applied ones.
  1. `INSERT` the `flr` row: name `Flies Like Robots`, Bandcamp URL `https://flieslikerobots.bandcamp.com`, contact line `Contact at flieslikerobots@gmail.com.`, `curated = true`. These are today's values from `Footer.svelte:8`, `Bandcamp.svelte:4` and `smart-pick.ts:118`.
  2. `INSERT … ON CONFLICT DO NOTHING` Nathan's two other seed facts (`home`: Virginia, FACT, public; `mr-kill`: INFERENCE, private) for `flr`. They move from `SEED_FACTS` (code) to data.
  3. `DELETE` the stored `artist-name` fact for `flr`, since it's now derived from the profile (R5).
  4. Backfill every stored pick with `artistName` and `uploadsRead` (R7, data-model).
  5. Then the foreign keys and the unique constraint on `users.artist_id`.
- **Linking:** none needed. Nathan's `users` row already has `artist_id = 'flr'`, put there by `scripts/invite.ts --artist flr`. No email or `uid` appears in code or SQL.
- **"Replaces the operator-assigned link" (spec, Key Entities):** a profile no longer exists only because an operator assigned an ID. Every user creates their own through the form. `--artist` survives only to attach an invite to a profile that already exists, which means Nathan's `flr` in a fresh environment. It never creates a profile.
- **Fresh environments:** the `flr` row is always inserted. An operator links Nathan's invite with the existing `--artist flr` flag, which stays. Nathan never sees the form (FR-012).
- **Fail loud:** if production has `artist_id` values other than `flr`, or two users linked to `flr`, the foreign key or unique constraint aborts the migration. Quickstart Q0 checks this with `scripts/invite.ts list` before deploying.
- **Rationale:**
  - Nathan's drafts keep the same name, links and contact (SC-004) without code constants.
  - The surname never appears: the credit line comes from his own uploads at pick time, as it does today.
- **Alternatives:**
  - A seed script run by hand: one more manual step, easy to forget, and no atomicity with the schema. Rejected.
  - A first-use seed in app code (today's `listFacts` pattern): keeps FLR values in code (FR-013). Rejected.

## R4 · Who gets Nathan's voice and the brand guide

- **Decision:** `artists.curated boolean not null default false`. Only the migration sets it, for `flr`, and the app can't write it.
  - `curated` selects `ARTIST_VOICE` and Nathan's credit wording (`ARTIST_CREDITS`) over the generic rules (R10).
  - It also gates `/brand` and the brand-guide APIs (spec Assumption: brand stays Nathan's).
  - Spec 005 replaces the column with per-artist voice and brand.
- **Rationale:** FR-013 bars FLR values in code. The artist ID `flr` is one, so `profile.id === 'flr'` would break FR-013. Constitution IV puts artist-specific values on the profile, and a flag on the profile does exactly that.
- **Alternatives:**
  - An `id === 'flr'` constant: smallest diff, but breaks FR-013. **Listed as an open question for the owner.**
  - A `NATHAN_ARTIST_ID` env var: config sprawl for one row. Rejected.
  - Voice rules stored as data per artist: that's spec 005's job. Rejected for 004.

## R5 · Artist facts

- **Decision:** `listFacts(artist, memory)` returns facts derived from the profile, plus stored facts only when `memory` is true (`artistJob`).
  - **Always, from the profile:** `artist-name` (FACT, public, FR-014). Also `contact` (FACT, public) when a contact line is set.
  - **Memory only:** stored rows, which is Nathan's `home` and `mr-kill` today.
  - `SEED_FACTS` and the first-use seed are deleted.
- **Why `contact` is a fact:** `allowedLinks` keeps only links found in public FACT and APPROVED records. A contact line with a link (spec edge case: "allowed as the user wrote it") would otherwise be stripped from the description and the Bandcamp credits.
- **Alternatives:** have the server append the contact line instead of the model. That changes where the line sits in Nathan's descriptions (SC-004 risk). Rejected.

## R6 · Identity reads through the owner's grant

- **Decision:** a new `ownUploads(accessToken, count)` in `src/lib/server/platforms/youtube/youtube.ts`. It replaces the key-based `recentVideos`, which is deleted.
  - `channels.list?mine=true&part=contentDetails` (bearer) gives the uploads playlist.
  - `playlistItems.list?part=contentDetails&maxResults=count+5` (bearer).
  - `videos.list?part=snippet` (bearer). No `statistics`: identity needs only titles, descriptions and thumbnails, and no statistic is fetched or stored (FR-015).
  - The pick reads 3. The brand guide reads `BRAND_VIDEOS` (30), which fits inside one `playlistItems` page (`maxResults` ≤ 50).
- **Access:** `getConnection(owner)`, then `accessTokenFor(owner, connection.channelId)`.
  - Not connected, or `accessTokenFor` returns null (revoked at Google): the pick runs without identity and records `uploadsRead: false` (US2 AS4).
  - YouTube answers 401 or 403 (`uploadFailure` → `access-lost`): `access.refused(job.id)` marks the grant, and the pick runs without identity.
  - Any other error is rethrown and fails the step, as `recentVideos` errors do today.
- **Gate:** identity reads still need `artistJob` (AGENTS.md). Every job created from now on has an artist, so that's every new job.
- **Quota:** 3 units per pick and 3 per brand proposal, charged to the OAuth client's project. That's negligible next to uploads.
- **Policy:** this is Authorized Data shown only to the authorizing user (Developer Policies III.E.3.b). The channel is identified as the connection's channel (III.E.3.e).
- **Alternatives:** keep the API key and pass the connection's channel ID. FR-007 and FR-015 require the owner's own grant. Rejected.

## R7 · Which name a pick and an approval use

- **Decision:**
  - The pick step reads the owner's current profile when it runs, so renames apply to the next pick and re-run (US4 AS1).
  - The name is stored on the pick as `Pick.artistName`.
  - Approval allows the pick's own `artistName` as a tag, not the current profile's. So a rename between pick and approval can't reject the draft's own artist tag, and approved fields never change (FR-011, SC-005).
  - A Short copies the parent pick (`createShort`), `artistName` included.
- **Backfill (R3 step 4):** jobs with `artist_id = 'flr'` get `artistName: 'Flies Like Robots'`. Every other stored pick gets `artistName: null`, meaning it was made before profiles, for a user without one. Every stored pick also gets `uploadsRead: false`.
- **Alternatives:** validate against the current profile name at approval. A rename would then break a pending review. Rejected.

## R8 · The artist tag always fits

- **Finding:** `pickTags` (`smart-pick.ts:374-392`) adds the artist key last. The 500-character loop then drops whatever no longer fits. A long name (up to 100 characters, 102 with the quotes YouTube adds for spaces) can be dropped, which breaks SC-003.
- **Decision:** count the artist tag's length first, then fill the model's picks into what's left. The artist tag is kept exactly once, and deduplicated case-insensitively against candidates, as today.
- **YouTube rules (videos docs):** tags total ≤ 500 characters. Commas between items count. A tag with spaces counts its quotation marks. No characters are documented as forbidden in tags. Titles and descriptions forbid `<` and `>`.

## R9 · Validation

- **Shared module:** `src/lib/artist.ts` (pure, used by the form and the server, like `src/lib/metadata.ts`). It returns `FieldErrors`. The database repeats the rules as `CHECK` constraints.
- **Name:** trimmed, 1–100 characters, no `<` or `>` (FR-004).
- **Bandcamp URL:** trimmed, and empty means none. It must parse with `new URL()` and have protocol `https:`, a host, and no username or password (FR-004).
  - At most 2,000 characters: a defensive cap on an unbounded text field, not a product rule.
- **Contact line:** trimmed, and empty means none. At most 200 characters (FR-004).
  - It also can't contain `<` or `>`: YouTube descriptions forbid them, and `tidy()` strips them, so a line with them could never appear as written.
- **Messages** (plain labels):

  | Problem                   | Message                                     |
  | ------------------------- | ------------------------------------------- |
  | Empty name                | "Add the artist name."                      |
  | Name over 100             | "Artist names are at most 100 characters."  |
  | `<` or `>` in the name    | "Artist names can't contain < or >."        |
  | Bad Bandcamp URL          | "Use an https:// address for Bandcamp."     |
  | Contact over 200          | "Contact lines are at most 200 characters." |
  | `<` or `>` in the contact | "Contact lines can't contain < or >."       |

## R10 · Voice and credits by profile

- **`curated` (Nathan):** `ARTIST_VOICE` unchanged. `ARTIST_CREDITS` is built from the profile's contact line: the "hacked and slashed" credit line, then the contact line exactly. No contact line means no contact instruction.
- **Generic (everyone else, spec Assumption):** a new `GENERIC_VOICE`. It keeps `ARTIST_VOICE`'s plain-copy rules (short and literal, one straight sentence about the song, album placement only from notes or facts, no placeholders, no marketing words, no emoji). It drops Nathan's humor, asides and caps lines.
- **Generic credits:** a credit line only when `recentUploads` carry one, in their wording and with the credited name exactly as there. The contact line exactly, when set.
  - This credit-line rule is not settled by the spec. **Listed as an open question.**
- **Wording fix:** `smart-pick.ts:184` says "Keep his slang". It becomes "Keep the artist's slang" for every run.
- **Bandcamp credits:** every profile now gets "the credit line and contact line from the description, exactly as written there", not an empty string.
- `ARTIST_VOICE` itself doesn't change (AGENTS.md: only on new evidence).

## R11 · Bandcamp links

- **Editor:** `new URL('/edit_track', bandcampUrl).href`. For Nathan that's `https://flieslikerobots.bandcamp.com/edit_track`, exactly today's constant (SC-004).
- **Footer:** links to the stored URL as entered.
- **Undocumented:** Bandcamp publishes no docs for `/edit_track`.
  - Gate G1 (quickstart Q6, 2026-10-25): any `*.bandcamp.com` artist subdomain sends signed-out visitors to sign-in, and bounces them back to that artist's `/edit_track`.
  - Whether custom-domain artist sites serve it is unknown and unchecked. **Listed as an open question:** should the field accept only `*.bandcamp.com`?

## R12 · Display

- **Layout data:** `+layout.server.ts` returns `artist: { name, bandcampUrl, curated } | null` from `locals.user.artist`. Signed out, it's null.
- **Header:** the artist name leads the channel row, followed by the channel handle and counts when connected (FR-009).
- **Menu:** Settings for every signed-in user. Brand guide only when `curated`.
- **Footer:** signed in with a profile, "Built for <name> by Ashley Childress", with the name linked to the Bandcamp URL when set. Otherwise "Built by Ashley Childress". The license, socials and legal links are unchanged (FR-009, spec Assumption).
- **Page description (FR-010):** "Release agent for musicians: Gemini watches and listens to a music video, then drafts and verifies the YouTube upload."
- **Privacy page:** `privacy/+page.svelte:24-25` says "Linked artist profiles also store…". It must say every account stores an artist name and an optional Bandcamp URL and contact line. The privacy policy has to disclose new stored data.

## R13 · A pick whose owner has no profile

- **Case:** only jobs created before this feature by users who haven't saved a profile yet. Job creation requires one from now on (R14).
- **Decision:** the pick step returns the wait `'Add your artist name first.'` before any model or YouTube call. The working screen shows it with a link to `/settings`. A wait never fails the job (constitution III). Re-run and retry reach the same wait.
- **Alternatives:**
  - Run the old unnamed pick: breaks FR-005, and it's a compatibility path (constitution VI). Rejected.
  - Fail the job: a missing input isn't a failure. Rejected.
- Not settled by the spec. **Listed as an open question.**

## R14 · Starting a job needs a profile

- **`POST /api/jobs`** returns `409 "Add your artist name first."` when `locals.user.artist` is null (FR-003 AS4).
- **`POST /api/jobs/{id}/short`** refuses the same way, since a Short is a job.
- **Database:** `jobs_insert` tightens to `artist_id is not null and artist_id = <caller's artist_id>` for top-level jobs. Shorts keep `soundboard_owns_job(parent_id, artist_id)`.

## R15 · Rebasing onto 003-resumable-upload

- 003 touches `jobs/create.ts`, `jobs/actions.ts`, `media/gcs.ts`, `routes/new/+page.svelte`, `playwright.config.ts`, `deploy.sh`, and maybe adds a migration.
- 004 adds no `jobs` column. Its schema change is the new `artists` table plus foreign keys, a unique constraint and a policy.
- If 003 lands a migration numbered `0005`, then after the rebase: delete 004's migration and its snapshot and journal entry, rerun `pnpm drizzle-kit generate --name artist_profiles`, and paste the R3 data block back in at the same place. Never renumber by hand.
- Expected textual conflicts:
  - `create.ts` (the profile guard sits next to 003's session code)
  - `new/+page.svelte` (004 only wraps the form in a profile check)
  - `playwright.config.ts` and `deploy.sh` (004 only deletes `FLR_CHANNEL_ID` lines)

## R16 · Test scope

- **Unit (PGlite, real migrations):**
  - the migration's `flr` row and facts
  - RLS on `artists`: read and update only your own; no `curated`; no second profile; no direct link
  - the profile API
  - the pick prompt, tags and facts for a curated and a generic profile
  - the owner-grant identity read and its failures
  - approval against the pick's `artistName`
  - the missing-profile wait
- **E2E (both projects, Pixel 7 primary):**
  - the form on `/new` for a user without a profile
  - Settings edits
  - header, footer and Bandcamp screen for a non-Nathan user
  - signed-out pages naming no artist
- **Not tested:** YouTube's own tag acceptance, and Bandcamp's editor page. Those are provider behavior, and re-proving it catches no break in this code.

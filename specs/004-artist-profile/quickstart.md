# Quickstart: validate the artist profile

Run every shell command with `export PATH="$HOME/.volta/bin:$PATH";` first. `node -v` must print `v24.22.1`.

## Q0 · Operator pre-check (before the migration reaches any shared database)

- `node --env-file=.env scripts/invite.ts list` against the target database.
- The `artist_id` column must hold only `flr` or `-`, and `flr` at most once.
- If anything else shows up, the migration's foreign key or unique constraint will abort it (research R3). Fix the rows by hand first. Don't print the connection string.

## Q1 · Automated

- `make ai-checks` passes: format, lint, typecheck, unit tests at coverage floors 85/85/85/80, build. Zero warnings.
- `pnpm exec playwright test` passes on desktop Chrome and Pixel 7. The [contract](contracts/artist-profile.md) lists the screens covered.

## Q2 · Migration on PGlite

The unit suite covers this:

- `artists` has the `flr` row with today's name, Bandcamp URL and contact line, and `curated = true`.
- The `flr` facts are `home` and `mr-kill`, and there's no stored `artist-name`.
- A seeded pre-migration pick on an `flr` job reads back with `artistName: 'Flies Like Robots'`.
- A seeded brand row with `basedOn` reads back with `uploadCount` and no video IDs.

## Q3 · First-run form (US1)

1. `pnpm dev`. Sign in as an invited account with no profile.
2. Open `/new`. The artist form shows instead of the new-release form.
3. Save with an empty name → "Add the artist name.", and nothing is saved.
4. Save a name → the new-release form appears, and the header shows the name.
5. `curl -X POST /api/jobs` with the session of a user without a profile → `409 "Add your artist name first."`

## Q4 · Display (US3)

- Signed in as the non-Nathan user: the header, the footer and the Bandcamp screen show their own name and links, and no Flies Like Robots value.
- Without a Bandcamp URL, the Bandcamp screen shows "Add your Bandcamp URL in Settings".
- Signed out: `/`, `/privacy` and `/terms` name no artist. The footer reads "Built by Ashley Childress".
- `<meta name="description">` names no artist.

## Q5 · Live pick (US2, US4), Gemini share ≤ $0.40

- **Before:** read `/private/tmp/claude-501/-Users-anchildress1-git-personal-soundboard/62e697ca-854d-4335-b7d9-d69a103885aa/scratchpad/gemini-ledger.md`. Stop if the run's budget is spent.
- **Video:** the shortest `$HOME/Downloads/*.mp4` (read-only), ideally ≤ 60 s. That's one analyst window and one pick. PRD cost: about $0.25 for a 15-minute job, so a one-window job costs a small fraction of the share.
- **Run:**
  1. As the non-Nathan user, with their own YouTube channel connected (identity reads are read-only), start the release and watch it reach Review.
  2. Log each model call in the ledger: agent, model, approximate input and output tokens, estimated cost.
- **Check the draft:**
  - The tags include the profile name exactly once.
  - The description body and Bandcamp credits end with the contact line exactly. A cleared contact means none.
  - There's no credit line (generic profile).
  - No "Flies Like Robots", `flieslikerobots` or Nathan contact text anywhere.
  - If the dev server reports to Sentry, the `smart-pick` span input shows `[YouTube uploads: 3]` instead of upload text. The unit suite asserts this either way.
- **Grant wait, no model call:**
  1. Disconnect YouTube on Connections.
  2. Re-run: the job waits on "Reconnect YouTube", and the ledger gets no entry.
  3. Reconnect: the pick continues.
- **Rename (US4):**
  1. Rename on `/settings`.
  2. Re-run the model, but only if the ledger still has room: the new pick uses the new name.
  3. An approved job's fields don't change. Check this with a seeded or earlier approved job, not by uploading.
- **No approval or upload in this check.** If an upload is ever needed, it goes only as `private`, and never when the connected channel looks like Nathan's (brief).

## Q6 · Gate G1: Bandcamp editor URL (tasks T004 and T043, research R12)

- Open `https://<a second artist>.bandcamp.com/edit_track` signed out. It should lead to Bandcamp's sign-in, not a 404.
- Validation accepts only `https://<name>.bandcamp.com`, so this gate covers every accepted URL. Reaching the editor after sign-in follows Bandcamp's `bounce` parameter, which today's feature already exercises for Nathan's own account.
- **Result, 2026-10-25** (`curl`, signed out, no cookies):
  - `https://flieslikerobots.bandcamp.com/edit_track` → `303` to `bandcamp.com/login?bounce=https://flieslikerobots.bandcamp.com/edit_track`.
  - A second artist, `https://amandapalmer.bandcamp.com/edit_track` → `303` to `bandcamp.com/login?bounce=https://amandapalmer.bandcamp.com/edit_track`.
  - A subdomain that doesn't exist bounces to `bandcamp.com/edit_track` instead, so a mistyped subdomain lands on Bandcamp's own editor after sign-in.
  - **Signed-out redirect verified for every accepted URL. Custom domains are refused by validation.**
- **Authenticated editor check: pending, owner to run (T043).** It doesn't block implementation.
  1. Sign in to Bandcamp as Nathan in a normal browser.
  2. Open `https://flieslikerobots.bandcamp.com/edit_track`.
  3. It must open his track editor. Record the result and date here. The PR calls this check out until it's recorded.

## Q7 · Nathan unchanged (SC-004)

On a database copy that has Nathan's linked row, with his YouTube channel connected (identity reads now need his grant):

- `/new` shows the new-release form, not the artist form.
- The header shows "Flies Like Robots".
- The Bandcamp screen opens `https://flieslikerobots.bandcamp.com/edit_track`.
- A unit test asserts his pick prompt carries `ARTIST_VOICE` and the credit-line instruction, and his finalized description ends with `Contact at flieslikerobots@gmail.com.`, placed by the app.

## Q8 · Gate G2: the deadline aborts a stalled token refresh (task T005, research R14)

- **Result, 2026-10-25:** a real `OAuth2Client` (`google-auth-library` 11.1.0, `gaxios` 7.3.1), refresh token `fake`, `endpoints.oauth2TokenUrl` pointed at a local server that never answers.
  - With `transporterOptions: { signal: AbortSignal.timeout(1500) }`, `getAccessToken()` rejected "The operation was aborted." after 1505 ms.
  - The run was a throwaway script, deleted afterwards. Nothing reached Google.
- **Passes.** A library upgrade reruns this check.

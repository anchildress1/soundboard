# Quickstart: validate per-artist voice and brand guide

Run every shell command with `export PATH="$HOME/.volta/bin:$PATH";` first. `node -v` must print `v24.22.1`.

## Q0 · Operator pre-check (before the migration reaches any shared database)

- 004's migration is applied there: `artists` exists and exactly one row has `curated = true`. Otherwise this migration raises (research R2).
- Nathan's approved brand guide exists in `artist_memory` (`kind = 'brand'`, `key = 'approved'`). If it doesn't, the migration still runs, and Nathan's Brand guide shows "Not set" (FR-009 needs it present).
- Any pending brand proposal is dropped by the migration. Nathan proposes again if he wants one.
- Don't print the connection string.

## Q1 · Automated

- `make ai-checks`: format, lint, typecheck, unit tests at 85/85/85/80, build. Zero warnings.
- `pnpm exec playwright test`: desktop Chrome and Pixel 7.

## Q2 · Migration and retention on PGlite

The unit suite covers it ([data-model](data-model.md)):

- Nathan's approved voice holds the 8 earlier rules plus the credit rule, verbatim and in order.
- His approved brand guide keeps its statement and rules, and its sources hold a count, no video IDs.
- No `brand` rows remain in `artist_memory`. `artists` has no `curated` column.
- A proposal 30 days old is invisible to the app and deleted by the cleanup statement. An approved row is never deleted.

## Q3 · Nathan unchanged (US3, SC-003)

- Signed in as Nathan on a database copy: `/brand` shows both Voice and Brand guide approved, with "Carried over from your earlier rules" on the voice.
- A unit test builds his pick prompt and asserts each earlier `ARTIST_VOICE` rule and the "hacked and slashed" credit example appear verbatim and in order, and the brand block equals his approved guide.

## Q4 · Live local validation (US1, US2), Gemini share ≤ $0.40

- **Before every call:** read `/private/tmp/claude-501/-Users-anchildress1-git-personal-soundboard/62e697ca-854d-4335-b7d9-d69a103885aa/scratchpad/gemini-ledger.md`. Stop live calls when the share is spent. Log each call: agent, model, input and output tokens, estimated cost, latency.
- **Database:** the dev Neon branch only, after Q0 passes there. `.env` is dev-only.
- **User:** a non-Nathan invited user (`node --env-file=.env scripts/invite.ts add <email>`) with a saved artist profile.
- **Channel:** connect a test channel through Connections (👤 Google consent). Confirm the connected channel title isn't Flies Like Robots before any proposal; if it is, stop and report.
- **Run** (`pnpm dev`, browser on the Pixel 7 viewport):
  1. Open `/brand`. Both sections read "Not set".
  2. Voice → Propose. Expected cost about $0.07 (research R5). Check:
     - the source list names the channel's own uploads and the edit count
     - the rules describe that channel's writing, not Nathan's
     - the `voice-guide` call took under 33 s; if not, raise `minCallMs` in `ai/model.ts` and record it
  3. Edit one rule, Approve. The voice shows approved, with counts only.
  4. Brand guide → Propose. Expected about $0.05 (research R6). Edit, Approve.
  5. Time 1 → 4 from the first click: under 5 minutes (SC-001).
  6. Open `/brand` in a second tab, propose a new voice in tab 1, then press Approve in tab 2: "The guide changed in another tab. Reload to see it.", and tab 2's text stays.
  7. **Optional pick, only if the ledger has room for about $0.06 more:** one release on the shortest `$HOME/Downloads/*.mp4` (one window). Read the `smart-pick` span in Sentry or the dev log: the voice block is the approved rules, not `GENERIC_VOICE` or Nathan's. No approval, no upload.
  8. Last, disconnect YouTube and propose the brand guide: the button shows "Reconnect YouTube" with a link to Connections, and no model call runs.
- **Database check:** `select status, jsonb_typeof(sources->'uploads') from artist_guides` for the user: approved rows say `number`.

## Q5 · Retention job (👤, deployment freeze applies)

- After merge and an operator-authorized deploy, redeploy `genrecleanup` (`docs/operations/youtube-retention.md`). Confirm one scheduled run's response has both `deleted` and `proposals` counts.

## Q6 · Post-release check with the artist (SC-005)

- For 4 songs, show the artist a draft made with their approved voice and one with `GENERIC_VOICE`, unlabeled. They prefer the approved-voice draft at least 3 times. Recorded after release; not a merge gate.

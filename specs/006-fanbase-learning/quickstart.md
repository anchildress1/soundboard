# Quickstart: validate fanbase learning

Runs against the dev environment only: `.env` (dev Neon branch, dev OAuth client), `pnpm dev`. Nothing here deploys. Shapes: [contract](contracts/fanbase-learning.md). Reasons: [research](research.md).

## Rules for every live step

- Start each shell with `export PATH="$HOME/.volta/bin:$PATH"`; `node -v` must print `v24.22.1`.
- **Gemini budget:** this spec's live share is **$0.50** for the whole implementation (research R15). Before each live model call, read the run's Gemini ledger and append agent, model, approximate input and output tokens, and estimated cost. Stop when the share is spent; name the remaining steps **unverified**.
- **Channel:** before any live YouTube read, confirm the connected channel on `/connections`. If it is Flies Like Robots, stop and report. No step here uploads.
- Never print `DATABASE_URL`, tokens or keys.

## Q0 · Migrations on the dev branch

1. `pnpm exec drizzle-kit migrate` with the dev branch's owner URL from `.env`.
2. Expect the four new tables, `artist_guides.influence`, the functions and the trigger (data-model). `pnpm test` covers RLS; this only proves the migration applies.
3. Seed the test artist's approved brand guide on the dev branch (one `artist_guides` row, `kind = 'brand'`, `status = 'approved'`), so sliders can save without a paid brand proposal.

## G1 · Gemini hears a public YouTube URL (gate, before hearing code)

- **Run:** `node specs/006-fanbase-learning/gates/g1/g1.mjs <public music video URL>` from an isolated directory with the repo's pinned `ai` and `@ai-sdk/google`, `GEMINI_API_KEY` set. Two `peer-match`-shaped calls: a 60 s static clip, and a private or removed video ID. About $0.02.
- **Pass:**
  1. the clip's reply describes the audio
  2. the `fetch` host log shows no `youtube.com` or `googlevideo.com` request from our process
  3. `usage.inputTokens` fits about 60 s of low-resolution video (roughly 6,000), not the whole video
  4. the bad URL's status and message are recorded
  5. latency is recorded for `minCallMs`
- **Writes:** `gates/g1/result.json` (no key, no URL query).
- **Fail:** `PEER_HEARING` stays unset; matches are metadata-only.

## G2 · Analytics with the incremental scope (gate, owner clicks consent)

1. Before sharing: run `node specs/006-fanbase-learning/gates/g2/g2.mjs`. With a grant that lacks the scope, record the status and reason (they map to `analytics-not-shared`).
2. Sign in as the dev test user (channel not Nathan's). On `/connections`, **Share analytics** → Google's consent screen. 👤 The consent click is the owner's.
3. Expect `/connections?analytics=shared` and "Analytics: Shared".
4. Run `g2.mjs` again. It records, with no token and no channel name:
   - one public upload's totals call and its coverage call (`dimensions=day`, `startDate = endDate = requested_end`)
   - an upload from the last 3 days, whose coverage call is expected to return no row (`unknown`)
   - a video with no data (no rows → every metric unknown)
5. Writes `gates/g2/result.json`.

## Q1 · Research continues with the browser closed (FR-003, SC-006)

1. `pnpm dev`. As the test user (profile set, brand guide approved, analytics shared), start a release with a ≤ 60 s test video from `~/Downloads` (read only).
2. Watch Listening finish. The working screen shows "Researching similar artists" and that leaving is safe.
3. Close the tab within 5 seconds of that line appearing.
4. Wait 4 minutes. In the dev server log, expect `research.stage` deliveries for `learn`, `discover`, `match` and `releases` (each possibly repeated as batches), then done. Each under 110 s.
5. Reopen the release. The pick runs and the draft reaches Title.
6. In the dev database, `research_runs` shows `done` and `job_research` holds one row for that `run_id`. Rerun a delivery in a Node REPL with the same `{ runId, seq }`: it's acknowledged as stale, and the row's `evidence` is byte-for-byte unchanged.

## Q2 · Recommendation and peers in review (FR-006, FR-016–FR-019, SC-002, SC-003)

1. On the Approve summary, expect:
   - a Recommendation with approach, intended outcome and limits
   - current and target ranges (or the hidden-count limit)
   - no number about views, subscribers or engagement in the recommendation text
2. Expect the Peers disclosure:
   - each peer labeled heard or "metadata only", secondary where it applies, with an explanation
   - statistics as reported with the retrieval date; engagement labeled "calculated"
   - no totals across peers
3. **Not a peer** on one. Re-run the model: the draft cites none of its sources.
4. Each field's "Why this" lists cited sources. At default settings, Wording and Feel cite no peer.

## Q3 · Sliders (FR-021–FR-025)

1. `/settings`: the sliders show Sound 1, Feel 0, Wording 0, Discovery 4, Structure 4. Set Wording to 4 and save.
2. The earlier pick still shows its own settings. (Generated behavior at each level is covered by E1, not by a second live pick.)
3. As a second test artist with no approved brand guide: Save is disabled with the brand-guide line.

## E1 · Fixed-evidence evaluation (US1 AS4, SC-002, SC-005; ≈ $0.30)

- **Run:** `pnpm exec vitest run --config specs/006-fanbase-learning/eval/vitest.eval.config.ts` with `GEMINI_API_KEY` set and the ledger read first. It feeds one fixed evidence fixture through the real pick three times (research R15):
  1. every role at 0, outcomes missing
  2. every role at 2, outcomes that conflict with the peers
  3. every role at 4, one successful adopted release
- **Pass criteria:** per research R15. Writes `eval/result.json` with each draft, its citations, the check results and the cost.
- Any pick the share can't cover is recorded **unverified**.

## Q4 · Learning from results (FR-001, FR-007, SC-004, SC-005)

- With analytics shared, `artist_outcomes` holds rows for the test channel's public uploads, with metrics as reported or null, Pacific dates and the right `coverage`.
- Private uploads are absent and the limits say so.
- **Unverified locally unless the test channel has a public Soundboard release with analytics:** linking an adopted recommendation to its results is proven by unit tests (mocked Analytics) and E1 pick 3.

## Q5 · Retention and revocation (FR-015, SC-008)

1. `pnpm test -- genre-cleanup rls` covers the 29-day hide and the daily delete.
2. Live: Disconnect YouTube on `/connections`. `artist_outcomes` for the test artist is empty. Reconnect afterwards.

## Q6 · No research on page loads (US3 AS4)

- Reload `/`, `/jobs/<id>` and `/settings` 5 times. `research_runs.updated_at` doesn't change, and the dev log shows no delivery.

## After deploy (operator only, never run by agents; deployment freeze applies)

1. Follow `docs/operations/research-runner.md` for the one-time `anchildress1-unstable` setup, then `GCP_PROJECT_ID=anchildress1-unstable APP_DOMAIN=<unstable URL> ./deploy.sh`. It deploys that project's own service, queue and IAM. Production is untouched.
2. Deploy `genrecleanup` for the unstable Neon branch.
3. Run one release with the browser closed after Listening. Cloud Tasks logs show deliveries, with 200s at the end.
4. A forged POST to `/api/research/task` without a token returns 401.

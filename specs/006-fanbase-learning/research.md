# Research: Learn what grows the fanbase

Checked 2026-10-25 against:

- `005-artist-branding` at `8eaedae` (final plan, research, data-model, contract, tasks), on `004-artist-profile` at `7256ea4`:
  - one `artists` row per user, linked by `users.artist_id`; every job needs a profile (004 R16)
  - `artist_guides` (voice and brand, proposed and approved); the approved brand row is 006's attach point, and approval rewrites only `body`, `sources`, `proposed_at`, `approved_at` (005 R10)
  - owner-grant reads `ownUploads(token, channelId, count, deadline)` and `accessTokenFor(uid, channelId, deadline)`; `identityFailure` outcomes `access-lost | busy | app-rejected` (004 R6, R8)
  - YouTube-sourced prompt text in its own part tagged `source: 'youtube'`, replaced by a placeholder in Sentry spans (004 R13); `AGENTS[agent].redactReply`, which records a guide agent's reply and reasoning as a placeholder and tags a re-ask's resent reply the same way (005 R4)
  - the 110 s step deadline threaded through every read, `budgetSignal(deadline)`, `hasModelTime(agent, deadline)` (004 R14)
  - the daily `genrecleanup` Neon Function and the `soundboard_cleanup` role; 005 hides proposals at 29 days so the daily delete always lands before day 30 (005 R4)
  - `SECURITY DEFINER` functions with `SET search_path = pg_catalog, public` (005 data-model)
  - constitution 4.0.0 as 005 T001 leaves it
- the code on `main` at `fcee227`: `pipeline/{pipeline,hashtags}.ts`, `ai/{model,smart-pick,numerics}.ts`, `jobs/{jobs,actions}.ts`, `platforms/youtube/{youtube,connection}.ts`, `auth/auth.ts`, `core/{schema,genre-cleanup,tracing}.ts`, `functions/genrecleanup.ts`, `service.yaml`, `deploy.sh`, `drizzle/0004_tenant_rls.sql`
- installed `@ai-sdk/google` 4.0.105 and `ai` 7.0.153 (`dist/index.js`: the Interactions model's `supportedUrls` and `getVideoProcessingField`)
- [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.D.2.c, III.E.2.a, III.E.4.a–h, III.L
- [YouTube Analytics `reports.query`](https://developers.google.com/youtube/analytics/reference/reports/query) and [time periods](https://developers.google.com/youtube/analytics/dimensions#time-periods), [OAuth 2.0 scopes](https://developers.google.com/identity/protocols/oauth2/scopes), [unverified apps](https://support.google.com/cloud/answer/7454865)
- [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) (YouTube URLs)
- Cloud Run [billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings) and [deterministic URLs](https://docs.cloud.google.com/run/docs/triggering/https-request), Cloud Tasks [HTTP target tasks](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks) and [pricing](https://cloud.google.com/tasks/pricing)
- the Codex review of the first plan (`#n` below)

Decisions marked **(owner)** are binding. Open items are in [plan.md](plan.md#owner-decisions-and-open-items).

## R0 · Governance gate

- **Constitution 4.0.0 → 5.0.0 (MAJOR)** through `/speckit-constitution`, first commit of the PR (T001):
  - III, first exception → "Research and learning stages (spec 006) run server-side through one Cloud Tasks queue. Each delivery calls the app service and runs one claimed stage under the step budget. Nothing else uses the queue."
  - III, second exception → "One scheduled database retention job deletes expired YouTube data: statistics, peer research, the artist's analytics outcomes, peer rejections, and proposal inputs."
  - Platform Terms, replace the derived-metrics bullet → "The owner states that YouTube accepted the derived-metrics amendment (III.L, recorded 2026-10-25). Numbers calculated from YouTube statistics MUST be computed in code from stored data and labeled as calculated; reported numbers are shown exactly as YouTube returns them. Model output MUST NOT contain statistics. No combined performance score."
  - Platform Terms, two new bullets:
    - "YouTube Analytics data is read only through the artist's optional analytics grant. It is refreshed or deleted within 30 days, and deleted when the grant is revoked."
    - "Peer channels and videos are kept at most 30 days. Long-lived records point at them only through expiring evidence, never by name or ID."
  - Media, Privacy and Secrets: "Sentry never records … the reply or reasoning of an agent that can restate YouTube API data (peer match, smart pick, guide proposals)." (#3)
  - Unchanged: the 30-day storage bullet and "API data MUST NOT be aggregated across different content owners."
  - **Why MAJOR:** both III exceptions change scope, and Platform Terms reverses a MUST. 004 R0 and 005 R12 classify an exception's scope change as a redefinition (precedent `cef38f2`). Owner confirms in review.
- **PRD** (T003) and **AGENTS.md** (T004): exact changes in tasks.

## R1 · Runner mechanism (FR-003, SC-006)

**Decision:** one **Cloud Tasks** queue, `soundboard-research`, whose HTTP deliveries call the app's Cloud Run service at `POST /api/research/task`. Each delivery runs one claimed stage batch under the 110 s step budget, then enqueues the next. No new service, worker or job.

The constitution exception permits research and learning to "run server-side, independent of the browser" and lets the plan choose the mechanism. It doesn't permit request-independent background work in the app, and AGENTS.md bans background workers outright. So each unit of work must be a request.

| Option                                         | Continues after the browser closes?                                                                                                                                 | Idle cost                                                                                                 | Verdict                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Background work after the response, in the app | No. "CPU is only allocated during request processing" under request-based billing, and an idle instance stops within 15 minutes. Work is lost on deploy or restart. | none                                                                                                      | Rejected: unreliable, and AGENTS.md bans background workers.                                                           |
| Same, with instance-based billing              | Mostly, until the instance is shut down ("can be shut down at any time")                                                                                            | the instance's whole lifetime                                                                             | Rejected: no durability, paid idle time, still a background worker.                                                    |
| Cloud Scheduler tick → app endpoint            | Yes                                                                                                                                                                 | One request per tick, 24/7. Every tick wakes Neon, so at 1-minute ticks its compute never scales to zero. | Rejected: constant load for a feature used a few times a week.                                                         |
| Cloud Run Job per run                          | Yes                                                                                                                                                                 | none                                                                                                      | Rejected: a second execution environment with its own env, secrets and service account, plus the Jobs API to start it. |
| Neon Function + trigger (like `genrecleanup`)  | Yes                                                                                                                                                                 | none                                                                                                      | Rejected: the KMS key, OAuth client secret and Gemini key would have to leave GCP.                                     |
| **Cloud Tasks → app endpoint**                 | **Yes.** Each delivery is an ordinary request, so CPU is allocated for it.                                                                                          | **none**: a task exists only while work does. First 1M operations a month are free.                       | **Chosen.**                                                                                                            |

- **Why it's the smallest:** the work runs in the app that already holds every credential, under the same claim-and-deadline model the page uses. The queue only delivers requests, with retries, backoff and `scheduleTime` for waits.
- **Volume:** about 6–10 deliveries per job (R2 batches), a few hundred operations a month.

## R2 · Delivery protocol

- **Run row:** `research_runs`, one per job (data-model): random `id` per run, `stage`, `seq`, `cursor`, a claim token with a 3-minute expiry, a failure streak, `wait`, `limits`. No YouTube data.
- **Task:** `POST {RESEARCH_TASK_URL}` with body `{ jobId, uid, runId, seq }`, an OIDC token for `RESEARCH_TASK_SA`, audience `RESEARCH_TASK_URL`, task name `<runId>-<seq>`.
  - A named task deduplicates: `409 ALREADY_EXISTS` counts as success.
  - Created through `projects.locations.queues.tasks.create` with `fetch` and an ADC access token from `google-auth-library`. No new package.
  - **Deadline (#10):** `enqueue(delivery, at, deadline)`. The token fetch and the HTTP call both run under `budgetSignal(deadline)`; a stall past the deadline is `DeadlineSpent`. Every stage stops taking new work when less than `RESERVE_MS = 8_000` remains, which covers the enqueue and the commit.
- **Handler** (`runDelivery`):
  1. Verify the OIDC token: signature, `aud = RESEARCH_TASK_URL`, `email = RESEARCH_TASK_SA`, `email_verified` (`OAuth2Client.verifyIdToken`). Otherwise `401`, nothing read. The service is public (`allUsers` invoker), so Cloud Run IAM can't do this check.
  2. `withIdentity(uid)`: every query runs under RLS as the job's owner.
  3. **Claim** with one conditional `UPDATE … RETURNING`: `job_id = $jobId and id = $runId and owner_uid = $uid and seq = $seq and stage not in ('done','failed') and (claim_until is null or claim_until < now())`, and the job exists and isn't `DISCARDED` (#6, #19). When it claims nothing:
     - row missing, another `runId`, `seq` below the row's, run finished, job discarded, or inactive owner → `200`, a stale delivery
     - `seq` above the row's (the next task arrived before the commit), or the claim is held → `503`, so Cloud Tasks retries with backoff
  4. `deadline = stepDeadline()` at claim entry, shared by every read, model call and the enqueue. Never restarted in a helper.
  5. Run one **batch** of the stage (below). Results stay in memory.
  6. Unless the stage ends the run, enqueue `<runId>-<seq+1>` with a `scheduleTime` that follows the wait. Enqueue failure → release the claim with nothing advanced and answer `500`. Nothing from the batch was written, so the redelivery starts clean.
  7. **Commit (#5):** one transaction. Every write function first checks the claim (`id = p_run and claim_token = p_token and claim_until > now()`, `FOR UPDATE`) and that the job isn't discarded; then the release (`stage`, `seq + 1`, `cursor`, `wait`, streak, claim cleared) with the same token check. A lost claim writes nothing and answers `200`.
  - The enqueue comes before the commit, so no crash leaves a run with no task. A crash between them leaves the `seq + 1` task getting 503 until the original task is redelivered and commits.
- **Batches with a committed cursor (#9):** every multi-call stage processes items from `cursor` while `remaining > RESERVE_MS + per-item estimate`, then commits the items done and the new cursor. The stage repeats (`learn → learn`, etc.) until its items are exhausted, then advances with `cursor = 0`.
  - A delivery that completes zero items (the first item didn't fit) waits +60 s and counts toward the failure streak, so a stage that can never fit ends `failed` instead of looping.
- **Waits** (constitution III: a wait never fails the run):

| Batch outcome                                              | Run row                                             | Next task                          |
| ---------------------------------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `ModelBusy`, YouTube `busy`, `DeadlineSpent` with progress | items done committed, `wait` set                    | +60 s                              |
| `ModelQuotaSpent`                                          | `wait = 'model quota spent'`                        | at `until` (next Pacific midnight) |
| Owner grant missing or refused (learn)                     | stage advances; `limits += 'youtube-not-connected'` | immediately                        |
| Zero progress, or any other error                          | streak +1; at 2 → `stage = 'failed'`                | +60 s, or none when failed         |

- **Idempotency (SC-006):** writes are keyed: `job_research` by `run_id`, `artist_outcomes` by `(artist_id, video_id)`, `peer_rejections` by `(artist_id, channel_id)`. A stale worker writes nothing (token check), so contents, not just counts, stay unchanged.
- **Queue config** (`deploy.sh`): `--max-concurrent-dispatches 1`, `--max-attempts 20`, `--min-backoff 10s`, `--max-backoff 300s`, `--max-retry-duration 3600s`. Dispatch deadline 180 s, under the 3-minute claim.
- **IAM** (`deploy.sh`): the runtime service account gets `roles/cloudtasks.enqueuer` on the queue, and `roles/iam.serviceAccountUser` on itself, granted to itself and to the Cloud Tasks service agent (HTTP-target doc). Enable `cloudtasks.googleapis.com`.
- **Local dev:** with `RESEARCH_QUEUE` unset and SvelteKit's `dev` true, `enqueue` calls `runDelivery` in-process after the delay, skipping only the OIDC check. Unset in a build, `enqueue` throws.
- **E2E:** `E2E_FAKES=1` aliases the queue module to `tests/e2e/fakes/tasks.ts`, which records enqueues. Research results come from seeded fixtures.

## R3 · When research runs and how the pick waits

- **Start:** the first `PICK` step creates the run (`stage = 'learn'`), commits, then enqueues `<runId>-0`. It's a pipeline step, not a page visit (US3 AS4). Page loads read state only.
- **Fresh run:** `started_at` under 29 days old. Its evidence is no older than that, since `retrieved_at ≥ started_at`.
- **Research failures never fail the release (#8, owner):**
  - Enqueue failure or an ambiguous acknowledgement at start → the run is marked `failed` with `error = 'research-unavailable'`, and the pick proceeds in the same step without peers. The step doesn't throw, so the job's failure streak is untouched. If the task was created after all, its delivery finds the run finished and returns 200.
  - A run that ends `failed`, or is still running 10 minutes after `started_at` (`RESEARCH_MAX_MS`), → the pick proceeds without it.
  - The draft's limits say so: "Peer research is unavailable; this draft uses the genre search only." or "Peer research didn't finish; …".
- **Waiting:** while the run is running and under 10 minutes, the pick returns `{ wait: 'researching similar artists' }`. A poll only reads the run.
- **Re-run** (`/rerun`): reuses a fresh `done` run. A `failed` or expired run is replaced by a new run (new `id`, `seq` 0).
- **Shorts:** no research. They reuse the parent pick's evidence binding (R13).
- **Discard (#19):** the discard transaction marks the run `failed` with `error = 'discarded'` and clears its claim. An in-flight batch then fails the token check and writes nothing; queued deliveries find the run finished. Other jobs' runs are untouched.

## R4 · Peer discovery (FR-016, FR-018)

- **Batch 1 (cursor 0):**
  - `search.list` with `part=snippet`, `type=video`, `videoCategoryId=10`, `order=relevance`, `maxResults=50`, `q` = the analysis's top two genre terms (`genreTerms`) + `music`. Uses the API key. Relevance, not `viewCount`: peers match on sound and genre first (FR-016).
  - Distinct channel IDs in result order, minus the owner's channel and fresh `peer_rejections` (SC-003).
  - One `channels.list(part=snippet,statistics,contentDetails)` for those channels and the artist's own channel (≤ 50 IDs, one call): title, description, uploads playlist, statistics as reported, `hiddenSubscriberCount` kept.
  - **Brackets before the cap (#18):** each channel's relation to the artist (R7). `other` and unknown are dropped (`skipped` with the reason); any unknown → `limits += 'peer-range-unknown'` ("Some similar artists hide their subscriber counts and weren't used.", FR-016). The rest are ordered next, then same, then two-up, each in search order, and the first 12 kept (`PEER_CANDIDATES`).
  - The artist's count hidden → no brackets this run: candidates stay in search order, `limits += 'artist-range-unknown'`.
  - Rejections refresh: `channels.list(id=<fresh rejected IDs>)` refreshes their `retrieved_at` (III.E.4.d "delete or refresh"); an ID YouTube no longer returns is deleted.
- **Batches 2+:** for each candidate from `cursor`, its newest upload (`playlistItems` 1 + `videos.list contentDetails,snippet`) as the sample to hear.
- **Writes:** the evidence row's candidates, the artist's stats and bracket, and the rejection refresh, in the token-guarded commit (R2).
- **Quota:** about 100 (search) + 2 + 2 × 12 units per run; the genre search adds 100. About 40 jobs a day on 10,000.
- **No peers outside the genre:** candidates come only from the genre query.

## R5 · Matching and hearing (FR-018, gate G1)

- **Agent `peer-match`:** one call per candidate on the analyst model, `low` thinking, `mediaResolution: 'low'`, 2048 tokens, `minCallMs` from G1's p95.
  - Input: the artist's song digest (genre, instrumentation, mood, tempo feel), the candidate's channel title and description, the sample's title and tags (tagged `source: 'youtube'`), and, when hearing is on, the sample as a YouTube watch URL clipped to its first 60 s (`providerOptions.google.processing = { type: 'static', startOffset: 0, endOffset: 60 }`).
  - Output: `{ channelKind: 'artist' | 'label' | 'compilation' | 'curator' | 'uncertain', sound: 'same' | 'different' | 'uncertain', explanation }`. Kept only for `artist` + `same`; anything uncertain is skipped.
  - Basis: `heard` when the clip was part of the call, else `metadata-only`, labeled so (FR-018).
- **Order and stop:** candidates in R4's order from `cursor`, as many per batch as the deadline allows. Matching stops once 5 next-range peers are kept, or the candidates run out. Selection then applies R7.
- **Installed SDK (`@ai-sdk/google` 4.0.105, Interactions model):** `supportedUrls['video/*']` includes `^https?://(www\.)?youtube\.com/watch\?v=.+`, so a YouTube URL file part is passed through, not downloaded. `getVideoProcessingField` maps `processing: { type: 'static', startOffset, endOffset }`. `sdkPart` gains a `{ type: 'youtube', url }` part (file part, `mediaType: 'video/mp4'`).
- **Gemini docs:** the YouTube URL feature "is in preview"; public videos only; about 100 tokens per second at low resolution. Clipping is documented for static processing but **not confirmed for YouTube URLs**.
- **Gate G1 (constitution V; orchestrator-run within the $0.50 share):** `specs/006-fanbase-learning/gates/g1/` (script + `result.json`), before any hearing code. Two calls, about $0.02. It must show:
  1. a public YouTube URL is heard through `generateText` with the Interactions model, and the reply describes its audio
  2. no request to `youtube.com` or `googlevideo.com` leaves our process (a `fetch` wrapper logs hosts)
  3. a 60 s static clip bills in proportion to 60 s (`usage.inputTokens`)
  4. what a private or removed video returns, which maps to `metadata-only`
  5. latency for `minCallMs`
- **G1 fails:** hearing stays off (`PEER_HEARING` unset). Every match is `metadata-only` and labeled. Nothing else changes.
- **AGENTS.md "NEVER send the model a URL"** gains one exception: a public YouTube watch URL of a peer's upload in `peer-match`. Never the artist's media.

## R6 · Peer releases and evidence (FR-005, FR-017, FR-020)

- **Per peer, one per batch item:** `playlistItems` (10 newest) + `videos.list(part=snippet,statistics,contentDetails)`, from `cursor`.
- **Comparable (#15):** `comparableLength(release, upload)`, separate from the genre search's `durationBucket` (which deliberately returns `undefined` near its boundaries):
  - both lengths known and above 0; unknown → not comparable
  - same side of 180 s (YouTube Shorts run up to 3 minutes, so a release of 180 s or less may be a Short; never compare it with a longer upload, or the reverse)
  - `|release − upload| ≤ max(60 s, 25 % of the upload)`
  - published 14 days to 3 years before retrieval
- **Selection within one channel (FR-017, #18):** from that peer's comparable releases, up to 3, each labeled with why:
  1. `newest`: the newest comparable release (an ordinary baseline, FR-005)
  2. `most-viewed`: the most views as reported, among the rest
  3. `most-engaged`: the highest engagement rate, calculated as `(likes + comments) / views`, among the rest
  - A release with a null statistic can't win that slot. Ties go to the newer release. Views and engagement stay separate; there's no combined score.
  - Comparisons only ever run within one channel's releases, never across channels (III.E.2.a).
- **Evidence row:** `job_research`, keyed by `run_id` (#7), `retrieved_at` = the run's first peer read (discover batch 1), never extended. It holds the artist's stats and bracket, candidates, peers `{ ref: 'P1', channelId, title, basis, explanation, stats, bracket }`, releases `{ ref: 'P1-R1', peer, videoId, title, description (700 chars), tags, hashtags, durationSec, publishedAt, stats, selectedAs }`, and `skipped`.
- **Pick inputs:**
  - Structure: peer releases replace `audienceTopVideos` (FR-020). With no peers, the genre search's top videos stay, and a limit says so.
  - Candidates: each peer release becomes its own `CandidateList` (`rankHashtags`, `rankTags`), labeled `P1-R1`, beside the genre lists `G1…G10`. Never merged, counted or weighted across lists (III.E.2.a).
  - Statistics as reported and calculated values, labeled, may appear in the prompt (owner). The model never writes them (R7).
- **Prompt volume:** at most 5 × 3 = 15 peer lists + 10 genre lists, capped as today.

## R7 · Derived metrics, brackets and calculated numbers (FR-010, FR-016–FR-019)

- **Policy basis (owner, #1):** on 2026-10-25 the owner stated that YouTube accepted the derived-metrics amendment (Developer Policies III.L, amendment form "Section 5" → "Analytics & Reporting"). The app can't verify an amendment through the API; the owner's statement, recorded here and in constitution 5.0.0, is the basis. The owner keeps YouTube's acceptance record (plan, open item O1).
- **What it allows:** brackets; numbers calculated from YouTube statistics; qualitative reasoning over the artist's own analytics; statistics in prompts.
- **What still holds:**
  - 30-day storage, enforced by the database (R10)
  - no aggregation across content owners (III.E.2.a): no sum, average or count of statistics across channels; per-release lists stay separate
  - peers stay individual, labeled examples
  - no combined performance score (FR-017)
- **Calculated numbers** (`src/lib/server/research/calculated.ts`): pure functions over stored rows, each returning `{ value: number | null, calculated: true }`:
  - `netSubscribers(outcome) = subscribersGained − subscribersLost` (the artist's own release)
  - `engagementRate(release) = (likes + comments) / views` (one release)
  - Any null input or zero views → `null` (unknown, FR-010). The review labels each value "calculated".
- **The model never emits statistics (#2):** `src/lib/server/ai/stat-guard.ts` runs on the recommendation's model-written text (`approach`, `intendedOutcome`, `followsWhy`; `limits` are server-built). It removes every sentence that states a statistic:
  - a number (digits, with `,` `.` `k` `m`) within three words of a metric word: views, plays, subscribers, subs, followers, fans, likes, comments, shares, watch time, impressions, CTR
  - any percentage (`20%`, `20 percent`, `twenty per cent`)
  - totals and differences stated with a number: "net", "total", "sum", "average", "gained", "lost", "rose", "fell", "grew" + a number
  - spelled-out quantities with a metric word ("twelve thousand views", "a dozen subscribers", "a few hundred plays")
  - multipliers: `2x`, "twice as many", "doubled", "tripled", "halved"
  - Regression cases (Codex): "1200 views", "net is 12 subscribers", "Views rose 20%", "twelve thousand views", "doubled its subscribers" are removed; "the last 3 releases", "60-second intro", "Track 2" stay.
  - A field left empty becomes "Not stated." `numerics.ts` keeps its audio job unchanged.
- **Brackets** (`src/lib/server/research/brackets.ts`), always on:
  - `bracketOf(subscriberCount | null)`: decade ranges `[0,100) [100,1k) [1k,10k) [10k,100k) [100k,1M) [1M,∞)`, the same boundaries for the artist and peers (FR-017). Hidden or missing → `null` (unknown).
  - `relation(artist, peer)` → `same | next | two-up | other`. `other` and unknown are dropped before matching (R4). Nothing further up is used (FR-018).
  - `selectPeers(kept)`: next-range peers first, up to 5. Fewer than 3 → same-range peers fill to 3, `limits += 'same-range-fallback'` ("Fell back to same-range artists"). Up to 2 two-up peers are added as `secondary` within the cap of 5.
  - **Two-up is never sole support (#18):** a recommendation whose `evidence` holds only two-up refs fails the server check and uses the shared re-ask (R12). Still failing → the recommendation is dropped (`null`) with the limit "No recommendation: only secondary evidence supported it." The draft still proceeds.
  - A bracket changes only when the reported count crosses a boundary (FR-019); `bracketOf` is a pure function of the count, so a single release's spike can't move it.
  - Review shows the current and target ranges.

## R8 · Learning from the artist's results (FR-001, FR-004, FR-007, FR-010, FR-015)

- **Stage `learn`, only when analytics is shared (R9):**
  1. `accessTokenFor(uid, channelId, deadline)`, which now also returns the connection's `updated_at` (`grantAt`). Then `ownUploads(token, channelId, 20, deadline)` with `part=snippet,status`. This covers releases from before Soundboard (FR-004).
  2. **Public only:** private and unlisted uploads are skipped, `limits += 'private-releases'`. Upload verification is never read as performance.
  3. **Per public upload, from `cursor`, two `reports.query` calls (#14):**
     - totals: `ids=channel==MINE`, `metrics=views,subscribersGained,subscribersLost`, `dimensions=video`, `filters=video==<id>`
     - coverage: `metrics=views`, `dimensions=day`, `filters=video==<id>`, with `startDate = endDate = requested_end`
     - Dates are **America/Los_Angeles** (Analytics days are Pacific): `requested_start` = the Pacific date of `publishedAt`, `requested_end` = start + 27 days, capped at today's Pacific date.
     - `coverage`: `open` while `requested_end` is today or later (the window is still running); `complete` when the coverage call returns a row for `requested_end`; otherwise `unknown` (data may be delayed). Never inferred from calendar age alone.
     - No rows from the totals call → every metric `null` (unknown).
  4. Commit outcomes for the batch through `soundboard_save_outcomes(p_run, p_token, p_grant_at, p_rows)` (R10). A revised report replaces the earlier row (FR-010).
  5. **Studio edits (#13):** live title, description and tags are compared with the publish record's `fields` on full, whitespace-normalized values, before the description is clipped to 700 characters for storage. `differs_from_approved` flags a change.
- **Reported vs calculated:** views, gained and lost as returned; the net is `netSubscribers`, labeled calculated (R7). Gained is labeled "on this video's page; a lower bound". Views are reach, not fans (FR-001).
- **Adopted (FR-007, #13):** `recordVerified` writes to the publish record:
  - `recommendation: { approach, intendedOutcome, evidence } | null`: what was suggested
  - `influence`: the settings used
  - `editedBeforeApproval`: whether the approved `fields` differ from the pick's fields
  - The approved `fields` are already on the record. A Short's record has `recommendation: null`.
- **Pick input per outcome `A<n>`:** the suggestion (if any), the approved fields as published (app data), the live metadata (YouTube data, tagged), `editedBeforeApproval`, `differsFromApproved`, coverage, metrics and calculated net. The prompt separates "suggested" from "what was actually published".
- **No stored lessons:** each pick reasons again over fresh outcomes and adopted publishes (FR-015).
- **Without consent:** no Analytics call; `limits += 'analytics-not-shared'`; approval unaffected (FR-002).
- **Grant missing or refused during learn:** `limits += 'youtube-not-connected'`, the stage advances. The pick still waits on `reconnect YouTube` (004).

## R9 · Analytics consent and the OAuth scope (FR-002)

- **Scope:** `https://www.googleapis.com/auth/yt-analytics.readonly`, requested only through an optional **Share analytics** connect, never at sign-in. `YOUTUBE_SCOPES` (the required pair) is unchanged, so `connectGrant`'s required check and every approval rule stay as they are.
- **Both scopes:** the `reports.query` page lists `yt-analytics.readonly` and says requests "now require access to the `youtube.readonly` scope", which the app already holds.
- **Flow:**
  - `/auth/login?connect=analytics` → `OAuthState.purpose = 'analytics'`
  - `authUrl` with `SCOPES + ANALYTICS_SCOPE`, `include_granted_scopes: true`, `prompt: 'select_account consent'`, `login_hint`
  - the callback reuses `connectGrant(uid, grant, 'connect')`; a grant missing a required scope never replaces a connected row
- **Shared** = `analyticsShared(connection)`: `status = 'connected'` and the scope granted. It lives in `platforms/youtube/` (constitution IV).
- **Stop sharing:** Google can't revoke one scope. Disconnect revokes the whole grant and outcomes are deleted then (R10).
- **Verification:** the app is already unverified with sensitive YouTube scopes, so the warning screen and the 100-user cap already apply. Adding this scope forces no new verification. It must be added to the OAuth client's Data Access and listed in the verification and YouTube audit submissions (T053).
- **Gate G2 (live, dev OAuth client, non-Nathan test channel, $0 Gemini):** share analytics (owner clicks consent), then record: one public upload's totals and coverage responses; a recent upload whose last days aren't reported yet (coverage `unknown`); a video with no data; the error for a token without the analytics scope (→ `analytics-not-shared`).

## R10 · YouTube terms, retention and revocation (FR-012, FR-015, SC-008)

- **Every stored YouTube datum carries `retrieved_at`, is hidden by RLS at 29 days on the database clock, and is deleted daily by `genrecleanup`.** Hiding at 29 days (as 005 does for proposals) means the daily delete always lands before day 30.

| Table                                   | Kind (Developer Policies)                                  | Refresh                               |
| --------------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| `job_research` (peers, releases, stats) | Non-Authorized (III.E.4.d)                                 | a new run after expiry                |
| `artist_outcomes`                       | Authorized: Analytics (III.E.4.b) and metadata (III.E.4.c) | every learn stage, under a live grant |
| `peer_rejections`                       | channel IDs, Non-Authorized                                | every discover stage (R4)             |

- **Citations bind to immutable evidence (#7):** `job_research` is keyed by `run_id`, and a new run inserts a new row instead of replacing the old one. A pick stores `researchRunId` and `evidenceExpiresAt` (`retrieved_at + 29 days`, non-API metadata). Its `P*` refs resolve only against that row. Once the row is hidden or deleted, review shows "Peer evidence expired on <evidenceExpiresAt>". A later run can never re-point an old citation.
- **Peer references after expiry (FR-015, Q1):** IDs have no exemption in III.E.4.d, so long-lived records hold only the internal ref. The model refers to peers by ref, `finalizePick` replaces any peer channel title in recommendation text with its ref, and a peer title in a draft field is a copy (R12).
- **Revocation (III.D.2.c, #4):**
  - A `connections` trigger deletes the artist's `artist_outcomes` when sharing ends: Disconnect, a detected revocation (`markRevoked`), or a reconnect without the scope.
  - **No write after revocation:** `soundboard_save_outcomes` takes `p_grant_at` and, in its transaction, locks the caller's `connections` row `FOR SHARE` where `status = 'connected'`, the scope is granted, and `updated_at = p_grant_at`. Not found → `28000`, nothing written. A disconnect that commits first makes the save fail; a save that locks first makes the disconnect wait, and the trigger then deletes what it wrote. A reconnect changes `updated_at`, so an in-flight report from the old grant can't land on the new one.
  - **Reads need current sharing:** `outcomes_read` also requires the caller's connection to be shared now.
- **No aggregation (III.E.2.a, SC-008):** no code sums, averages or counts statistics across channels. Calculated values are per release (R7).
- **Model-written statistics:** removed by the stat guard (R7). Audio numbers by `numerics.ts`.

## R11 · Sliders: storage, defaults, and the 005 open question (FR-021, FR-023, FR-025)

- **Shape:** `Influence = { sound, feel, wording, discovery, structure }`, each an integer 0–4. 0 means no peer influence, 4 the strongest, 1–3 blend. Relative, not a word percentage (FR-021).
- **Defaults (owner, Q3):**

| Role      | Default | Why                                                                                            |
| --------- | ------- | ---------------------------------------------------------------------------------------------- |
| Sound     | 1       | song analysis, with peer vocabulary helping describe it                                        |
| Feel      | 0       | the artist's own writing and edits                                                             |
| Wording   | 0       | the artist's phrasing                                                                          |
| Discovery | 4       | peer tags, limited to what was heard                                                           |
| Structure | 4       | peer patterns for length and order; identity and credit lines are always the artist's (FR-025) |

- **Storage:** `artist_guides.influence jsonb`, `CHECK (influence is null or (kind = 'brand' and status = 'approved'))` plus a shape check, written only through `soundboard_save_influence(p_influence)`.
  - 005's `guides_update` `WITH CHECK` requires `proposed_at` within 29 days, so a plain update to an older approved row would fail. The function avoids that.
  - 005's approve rewrites only four columns, so a new approval keeps the sliders.
- **005 Q2, decided (owner, Q2):** defaults apply; saving needs an approved brand guide. Without one, Save is disabled with "Approve your brand guide to save your own settings. Drafts use these defaults until then." and a link to Brand.
- **Per draft (FR-023):** `pick.influence` stores the settings used. Changing defaults never touches a stored pick.
- **Learning never writes `influence`** (FR-025): only `PUT /api/influence` does.

## R12 · Pick: sources, citations, checks (FR-006, FR-008, FR-009, FR-022, FR-024, FR-025)

- **Source refs in the prompt** (YouTube-sourced parts tagged `source: 'youtube'`): `analysis`; `voice` (approved voice or `GENERIC_VOICE`); `edits` (Soundboard feedback, labeled preference, FR-009); `identity` (own recent uploads); `A<n>` outcomes (R8); `P<n>` peers with bracket and `secondary` label; `P<n>-R<m>` releases with `selectedAs`; `G<n>` genre lists.
- **Allowed per role** (US1 AS2):

| Role      | Non-peer sources                      | Peer sources  |
| --------- | ------------------------------------- | ------------- |
| Sound     | `analysis`                            | `P*`          |
| Feel      | `voice`, `edits`                      | `P*`, `P*-R*` |
| Wording   | `voice`, `edits`                      | `P*`, `P*-R*` |
| Discovery | `G*`, `analysis`                      | `P*-R*`       |
| Structure | `identity`, `G*` (only with no peers) | `P*-R*`       |

- **Output additions:** `citations` per role; `recommendation: { approach, intendedOutcome, evidence: string[], follows: 'artist' | 'peers' | 'both' | 'none', followsWhy }`. Unknown or role-disallowed refs are dropped by the server.
- **Server checks after the reply:**
  - **Influence (FR-024):** level 0 → no peer ref for that role; 1–3 → at least one peer ref and one non-peer ref; 4 → at least one peer ref, and wording and feel need refs from at least 2 distinct peers (FR-022). Evidence the setting needs but the job lacks becomes a limit, not a mismatch.
  - **Copy (FR-022, constitution II, #17),** deterministic, words lowercased:
    1. a run of 6+ consecutive words shared with any single peer title, description or channel description
    2. a whole peer sentence (split on `. ! ?`) of 3 or more words appearing in a draft field
    3. a **distinctive phrase**: a 3–5 word run shared with one peer's text that contains at least one word found nowhere in the artist's own text (voice rules, edits, identity uploads), the analysis, or the job's candidate lists
    4. any peer channel title in a draft field
    - **Exempt:** a run made only of whole terms from the job's candidate lists (matched as terms, not as loose words), the song title, or the artist name. A run whose words each appear in some candidate term, but not as whole terms, is not exempt.
  - **Two-up support** (R7).
  - **Stat guard** (R7) strips; it never re-asks.
- **One re-ask allowance per pick (#16):** parse failure (`chatJson`), repeat of a skipped version (`runPick`), influence mismatch, copy, and two-up-only support share a single allowance. At most two provider calls per pick, under the one deadline. After it's spent:
  - influence mismatch → `influenceWarning: 'Influence settings not met'`; review isn't blocked (FR-024)
  - copy → the pick throws, a step failure (constitution II); a retry re-picks
  - parse or repeat → as today (step failure)
  - two-up-only → recommendation dropped (R7)
- **Deliberate peer influence never triggers a voice warning:** `brandCheck` stays about the brand guide.
- **Prompt rules added:** the slider text per role; artist outcomes measure fans and reach, peer evidence only reach; repeated comparable artist outcomes outrank loose peer observations; heard peers outrank metadata-only and next-range peers outrank secondary ones; tactics are tentative, never causes; feedback is preference; when artist and peer evidence conflict, say which is followed and why; with sparse evidence, say so; **never write a number about views, subscribers or engagement**.
- **Facts unchanged (FR-025):** `finalizePick`'s tag, hashtag, numeric, length, link and contact rules run after every setting.

## R13 · Recommendation, approval, Shorts and review (FR-006, FR-007, FR-013, FR-014, SC-004, SC-007)

- **`pick.recommendation`:** the model's approach, intended outcome, `follows` and evidence refs (after the stat guard), plus server-built `limits[]`: research unavailable or unfinished, `analytics-not-shared`, `youtube-not-connected`, private releases, few or no peers, same-range fallback, the artist's or peers' unknown ranges, hearing off, per-role unavailable evidence.
- **Approval pool (#11):** the union of the job's fresh genre lists and the fresh peer release lists of `pick.researchRunId`. When either pool has expired, the stored draft's own selected tags and hashtags stay approvable: the PRD's existing fallback, applied per pool.
- **Shorts (#12):** `createShort` copies the parent pick, which already carries `researchRunId` and `evidenceExpiresAt`, so the Short resolves the same peer lists with the original expiry. The Short's pick sets `recommendation: null` and `outcomeRefs: {}`. The evidence row's read policy keys on the parent job's owner, who is the Short's owner.
- **Review:**
  - Each field's "Why this" lists its cited sources.
  - The Approve summary adds a Recommendation block: approach, intended outcome, limits, influence warning, and the current and target ranges.
  - A Peers disclosure: name, `heard` or "metadata only", `secondary` where it applies, explanation, statistics as reported ("Public reach on YouTube") and calculated engagement labeled "calculated", with the retrieval date, and **Not a peer**.
  - The artist's own results: "Your results (YouTube Analytics)", reported metrics, calculated net, coverage.
  - No form, no extra step (FR-014, SC-007).
- **Not a peer:** `POST /api/jobs/{id}/peers/{ref}/reject` → `soundboard_reject_peer(channelId)`. Later runs exclude the channel; this job's re-runs drop its sources.
- **Short selection (FR-013 MAY):** not used (YAGNI).

## R14 · Model settings and Sentry (#3)

- New agent `peer-match` (R5). The smart pick keeps its settings, with more input and the citations and recommendation output.
- **Inputs:** every YouTube-sourced part is a placeholder in `invoke_agent` and `chat` spans: `[YouTube peers: <n>]`, `[YouTube releases: <n>]`, `[YouTube outcomes: <n>]`; the hearing URL `{ type: 'video', source: 'youtube' }`. 004's `source: 'youtube'` tag gains a `label`.
- **Replies and reasoning:** `peer-match` and `smart-pick` replies can restate peer metadata and private metrics, so both join 005's `redactReply` list:
  - `chat` span reply and reasoning → `[peer match: <n> chars]` and `[pick: <n> chars]`; the same for `agentOutput`
  - the shared re-ask resends the failed reply tagged `source: 'reply'`, which `redactTurns` turns into the same placeholder
  - The learn stage makes no model call. The hook keeps its reply (no API data in it).
  - Tests echo a sentinel private metric and a peer title from the request into the mocked reply and reasoning, and assert neither appears in any span.
- **Research spans:** each delivery is one `research.stage` span (`job.id`, stage, cursor); `execute_tool peer_search` and `execute_tool analytics_report` spans. Never a token or the OIDC JWT.

## R15 · Cost, live budget and the evaluation

- **Per job, added by 006:** up to 12 `peer-match` calls (about 6k tokens each, analyst prices) and about 20k more pick input tokens on Argon. Roughly $0.06.
- **Live share: $0.50** for the whole implementation, logged in the run's Gemini ledger before each call:

| Call                                     | Est.        |
| ---------------------------------------- | ----------- |
| G1, 2 `peer-match` calls                 | $0.02       |
| 1 analyze window (≤ 60 s test video)     | $0.01       |
| 12 `peer-match` calls                    | $0.04       |
| live pick at default sliders             | $0.10       |
| fixed-evidence evaluation, 3 picks (#20) | $0.30       |
| **Total**                                | **≈ $0.47** |

- The test artist's approved brand guide is seeded on the dev branch instead of proposed, which saves a brand call.
- **Fixed-evidence evaluation (#20):** one fixture (3 peers with distinct writing, their releases, and artist outcomes), three picks:
  1. every role at 0, outcomes missing (analytics not shared)
  2. every role at 2, outcomes that conflict with the peers
  3. every role at 4, one successful adopted release
  - **Pass, per pick:** citations meet the level for every role (wording and feel ≥ 2 peers at 4); the copy check passes; the stat guard stripped nothing (the model wrote no statistic); facts unchanged (FR-025). Pick 1's limits name the missing outcomes and its text claims no success. Pick 2's `followsWhy` names an `A*` and a `P*` ref. Pick 3 recommends trying the pattern again and attributes no cause (US2 AS5). Generated drafts are recorded for the owner to read.
  - Whatever the budget can't cover is reported **unverified**, by name.
- Stop at the share.

## R16 · Test scope

- **Unit (PGlite, real migrations; Sentry global mock; `fetch` mocked for YouTube Data, Analytics, Gemini, Cloud Tasks and Google certs; `google-auth-library` and KMS at the boundary):**
  - migration: tables, checks, RLS (own, fresh, 29-day hide), forged foreign-job and mismatched-artist run inserts refused, the write functions, the trigger, cleanup role
  - retention deletes and counts
  - queue: REST shape, dedupe, dev path, build throws, stalled token and stalled request against the deadline
  - delivery: OIDC, stale and discarded deliveries, held claim, `seq` ahead, enqueue failure, stale worker writes nothing (contents unchanged), batches finish a stage that doesn't fit one deadline, zero progress fails
  - each stage: positive, waits, errors, deadline threading
  - discovery filters, bracket order before the cap, rejections refresh; match keep/skip and labels; release comparability (180/181 s, 1141 s, unknown lengths) and selection
  - brackets, calculated values, the stat guard regression cases
  - learn: public only, Pacific dates and DST, coverage `open`/`complete`/`unknown`, revised report replaces, Studio edits on full values, delayed report after disconnect or reconnect writes nothing
  - sliders; pick prompt, citations, influence, copy (short distinctive phrases, exemption abuse), two-up, shared re-ask call count
  - approval across expiry; Shorts with peer-only tags; adoption; discard during research
  - Sentry: echoed private metric and peer title absent from spans
  - a page load never creates a run
- **E2E (both projects, Pixel 7 primary):** the research wait; a seeded finished run shows the recommendation, ranges, peers with labels and statistics, the artist's results, Not a peer; sliders with and without a brand guide; Share analytics; an expired citation.
- **Not automated:** generated quality beyond the evaluation's checks; Cloud Tasks in GCP (post-deploy check); Google's consent screen.

## R17 · The `anchildress1-unstable` environment (owner, Q7)

- **Whole environment:** its own Cloud Run service `soundboard` with the queue beside it, its own runtime service account, KMS key, GCS bucket, Secret Manager secrets, OAuth client and a separate Neon branch. Production is untouched until the owner promotes the code.
- **`deploy.sh`** already reads `GCP_PROJECT_ID`. It gains:
  - `APP_DOMAIN` from the environment, defaulting to today's production domain
  - the service's deterministic URL, `https://soundboard-<project number>.us-central1.run.app` (looked up with `gcloud projects describe`), as `RESEARCH_TASK_URL` = that URL + `/api/research/task`; it's known before the first deploy, so the OIDC audience is stable
  - the queue, its IAM, and the two new APIs
- **Never run** by agents. `docs/operations/research-runner.md` lists the operator's one-time steps: project, secrets pointing at the unstable Neon branch, OAuth client and redirect URI, `genrecleanup` for that branch, Data Access scope.

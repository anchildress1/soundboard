# Research: Learn what grows the fanbase

Checked 2026-10-25 against:

- `005-artist-branding` at `e7f0356` (plan, research, data-model, contract, tasks) and, through it, `004-artist-profile`:
  - one `artists` row per user, linked by `users.artist_id`; every job needs a profile (004 R16)
  - `artist_guides` (voice and brand, proposed and approved); the approved brand row is 006's attach point, and approval rewrites only `body`, `sources`, `proposed_at`, `approved_at` (005 R10)
  - owner-grant reads `ownUploads(token, channelId, count, deadline)` and `accessTokenFor(uid, channelId, deadline)`; `identityFailure` outcomes `access-lost | busy | app-rejected` (004 R6, R8)
  - YouTube-sourced prompt text in its own part tagged `source: 'youtube'`, replaced by a placeholder in Sentry spans (004 R13)
  - the 110 s step deadline threaded through every read, `budgetSignal(deadline)`, `hasModelTime(agent, deadline)` (004 R14)
  - the daily `genrecleanup` Neon Function and the `soundboard_cleanup` role, extended by 005 to expired proposals
  - constitution 4.0.0 as 005 T001 leaves it
- `004-artist-profile` at its tip `7256ea4` (re-review rulings). **005 was planned on `0a9176e`, before those rulings.** 006 inherits that gap; T002 rebases before code.
- the code on `main` at `fcee227`: `pipeline/{pipeline,hashtags}.ts`, `ai/{model,smart-pick}.ts`, `platforms/youtube/{youtube,connection}.ts`, `auth/auth.ts`, `core/{schema,genre-cleanup,tracing}.ts`, `functions/genrecleanup.ts`, `service.yaml`, `deploy.sh`, `drizzle/0004_tenant_rls.sql`
- installed `@ai-sdk/google` 4.0.105 and `ai` 7.0.153 (`dist/index.js`: the Interactions model's `supportedUrls` and `getVideoProcessingField`)
- [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.D.2.c, III.E.2.a, III.E.4.a–h
- [YouTube Analytics `reports.query`](https://developers.google.com/youtube/analytics/reference/reports/query), [OAuth 2.0 scopes](https://developers.google.com/identity/protocols/oauth2/scopes), [unverified apps](https://support.google.com/cloud/answer/7454865)
- [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) (YouTube URLs)
- Cloud Run [billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings), Cloud Tasks [HTTP target tasks](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks) and [pricing](https://cloud.google.com/tasks/pricing)

Decisions marked **(brief)** were made by the owner before planning and are binding. Open product questions are in [plan.md](plan.md#open-questions-for-the-owner).

## R0 · Governance gate

- **Constitution 4.0.0 → 5.0.0 (MAJOR)** through `/speckit-constitution`, first commit of the PR (T001):
  - III, first exception → "Research and learning stages (spec 006) run server-side through one Cloud Tasks queue. Each delivery calls the app service and runs one claimed stage under the step budget. Nothing else uses the queue."
  - III, second exception → "One scheduled database retention job deletes expired YouTube data: statistics, peer research, the artist's analytics outcomes, peer rejections, and proposal inputs."
  - Platform Terms, two bullets:
    - "YouTube Analytics data is read only through the artist's optional analytics grant. It is refreshed or deleted within 30 days, and deleted when the grant is revoked."
    - "Peer channels and videos are kept at most 30 days. Long-lived records point at them only through expiring evidence, never by name or ID."
  - **Why MAJOR:** both III exceptions change scope, and Platform Terms gains MUSTs. 004 R0 and 005 R12 classify an exception's scope change as a redefinition (precedent `cef38f2`). Owner confirms in review.
- **PRD** (T003): R4 audience evidence and voice, R5 review, R7 status, R9 connections, R11 tracing, Non-goals ("Competitor research beyond the genre search"), System design, the Postgres table, UX Settings and board copy, Open Questions. The spec's Supersedes list names each.
- **AGENTS.md** (T004): Architecture exceptions, Media URL rule, model-call settings, YouTube terms, Data and access, Tests. Exact lines in tasks.

## R1 · Runner mechanism (FR-003, SC-006)

**Decision:** one **Cloud Tasks** queue, `soundboard-research`, whose HTTP deliveries call the existing Cloud Run service at `POST /api/research/task`. Each delivery runs one claimed stage under the 110 s step budget, then enqueues the next. No new service, worker or job.

What the constitution 2.0.0 exception permits: research and learning "MAY run server-side, independent of the browser. Their plan chooses the mechanism." It doesn't permit request-independent background work in the app, and AGENTS.md bans background workers outright. The mechanism must make each unit of work a request.

| Option                                         | Continues after the browser closes?                                                                                                                                 | Idle cost                                                                                                 | Verdict                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Background work after the response, in the app | No. "CPU is only allocated during request processing" under request-based billing, and an idle instance stops within 15 minutes. Work is lost on deploy or restart. | none                                                                                                      | Rejected: unreliable, and AGENTS.md bans background workers.                                                           |
| Same, with instance-based billing              | Mostly, until the instance is shut down ("can be shut down at any time")                                                                                            | the instance's whole lifetime                                                                             | Rejected: no durability, paid idle time, still a background worker.                                                    |
| Cloud Scheduler tick → app endpoint            | Yes                                                                                                                                                                 | One request per tick, 24/7. Every tick wakes Neon, so at 1-minute ticks its compute never scales to zero. | Rejected: a constant load for a feature used a few times a week.                                                       |
| Cloud Run Job per run                          | Yes                                                                                                                                                                 | none                                                                                                      | Rejected: a second execution environment with its own env, secrets and service account, plus the Jobs API to start it. |
| Neon Function + trigger (like `genrecleanup`)  | Yes                                                                                                                                                                 | none                                                                                                      | Rejected: the KMS key, OAuth client secret and Gemini key would have to leave GCP.                                     |
| **Cloud Tasks → app endpoint**                 | **Yes.** Each delivery is an ordinary request, so CPU is allocated for it.                                                                                          | **none**: a task exists only while work does. First 1M operations a month are free.                       | **Chosen.**                                                                                                            |

- **Why it's the smallest:** the work runs in the app that already holds every credential, under the same claim-and-deadline step model the page uses. The queue only delivers requests. It adds retries with backoff and `scheduleTime` for waits, and nothing runs while there's no work.
- **Volume:** about 6 deliveries per job (R2 stages), so a few hundred operations a month.
- **Project (brief):** the queue, its IAM and the endpoint's environment are written into `deploy.sh` and `service.yaml` for GCP project `anchildress1-unstable`, which isn't configured yet. Never run. The script keeps reading `GCP_PROJECT_ID`; `docs/operations/research-runner.md` names `anchildress1-unstable` as the first target. The deployment freeze (`docs/operations/youtube-retention.md`) applies.

## R2 · Delivery protocol

- **Run row:** `research_runs`, one per job (data-model). It holds `id` (random, per run), `stage`, `seq`, a claim token with a 3-minute expiry, a failure streak, `wait`, and `limits`. It holds no YouTube data.
- **Task:** `POST {RESEARCH_TASK_URL}` with body `{ jobId, uid, runId, seq }`, an OIDC token for `RESEARCH_TASK_SA`, audience `RESEARCH_TASK_URL`, and task name `<runId>-<seq>`.
  - A named task deduplicates: enqueuing an existing name returns `409 ALREADY_EXISTS`, which counts as success.
  - Created through the REST API `projects.locations.queues.tasks.create` with `fetch` and an access token from `google-auth-library` (application default credentials). No new package.
- **Handler** (`runDelivery`):
  1. Verify the OIDC token: signature, `aud = RESEARCH_TASK_URL`, `email = RESEARCH_TASK_SA`, `email_verified` (`OAuth2Client.verifyIdToken`). Otherwise `401` and nothing runs. The service is public (`allUsers` invoker), so Cloud Run's IAM can't do this check.
  2. `withIdentity(uid)`: every query runs under RLS as the job owner. An inactive owner sees no rows, so the delivery returns 200 and does nothing.
  3. Claim with one conditional `UPDATE … RETURNING` (`id = $runId and seq = $seq and stage not in ('done','failed') and (claim_until is null or claim_until < now())`). When it claims nothing:
     - row missing, another `runId`, task `seq` below the row's, or the run finished → `200`, a stale delivery
     - task `seq` above the row's (the next task arrived before the release committed), or the claim is held → `503`, so Cloud Tasks retries with backoff
  4. `deadline = stepDeadline()` at claim entry, shared by every read and model call in the stage (AGENTS.md). Never restarted in a helper.
  5. Run the stage.
  6. Unless the stage ends the run, enqueue `<runId>-<seq+1>`, with a `scheduleTime` that follows the wait (below). Enqueue failure → the claim is released with nothing advanced, and the handler answers `500`. The stage's keyed writes stay; Cloud Tasks redelivers the same task, which re-runs the stage and overwrites them.
  7. Release with the claim token in one transaction: results, `stage`, `seq + 1`, `wait`, failure streak. Answer `200`.
  - The enqueue comes before the release, so no crash between them can leave a run with no task. A redelivery re-runs the stage with idempotent writes (below) and re-enqueues the same name, which is deduplicated.
- **Waits** (constitution III: a wait never fails the run):

| Stage outcome                                | Run row                                             | Next task                          |
| -------------------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `ModelBusy`, YouTube `busy`, `DeadlineSpent` | `wait` set, stage unchanged                         | +60 s                              |
| `ModelQuotaSpent`                            | `wait = 'model quota spent'`                        | at `until` (next Pacific midnight) |
| Owner grant missing or refused (learn stage) | stage advances; `limits += 'youtube-not-connected'` | immediately                        |
| Any other error                              | failure streak +1; at 2 → `stage = 'failed'`        | +60 s, or none when failed         |

- **Idempotency (SC-006):** every write is keyed. `job_research` upserts by `job_id`, `artist_outcomes` by `(artist_id, video_id)`, `peer_rejections` by `(artist_id, channel_id)`. A redelivered stage overwrites its own results and never adds rows.
- **Queue config** (`deploy.sh`): `--max-concurrent-dispatches 1`, `--max-attempts 20`, `--min-backoff 10s`, `--max-backoff 300s`, `--max-retry-duration 3600s`. Dispatch deadline 180 s: the 110 s budget plus slack, under the 3-minute claim.
- **IAM** (`deploy.sh`): the runtime service account gets `roles/cloudtasks.enqueuer` on the queue. It also gets `roles/iam.serviceAccountUser` on itself, granted to itself (to name itself in `oidcToken`) and to the Cloud Tasks service agent (to mint the token), per the HTTP-target doc. Enable `cloudtasks.googleapis.com`.
- **Local dev:** with `RESEARCH_QUEUE` unset and SvelteKit's `dev` true, `enqueue` calls `runDelivery` in-process after the `scheduleTime` delay. It skips only the OIDC check and uses the same code otherwise. With `RESEARCH_QUEUE` unset in a build, `enqueue` throws. Production can't fall back to in-process work.
- **E2E:** `E2E_FAKES=1` aliases the queue module to `tests/e2e/fakes/tasks.ts`, which records enqueues. Research results come from seeded fixtures.
- **Unit tests:** Cloud Tasks REST, Google's OIDC certificate endpoint and `google-auth-library` mocked at the process boundary (AGENTS.md).

## R3 · When research runs and how the pick waits

- **Start:** the first `PICK` step creates the run (`stage = 'learn'`), commits, then enqueues `<runId>-0`. It's a pipeline step, so it isn't the "page visit" that US3 AS4 forbids from launching research. An ordinary page load reads state only and never creates or enqueues a run (test).
- **Pick waits** with the new wait `'researching similar artists'` while the run is running. The page keeps polling the step; a poll only reads the run.
- **Proceed without peers** (FR-011) when either:
  - the run is `failed`, or
  - it's still running 10 minutes after `started_at` (`RESEARCH_MAX_MS`), which covers a lost enqueue.
  - The draft's limits then say so ("Peer research didn't finish; this draft uses the genre search only.").
- **Fresh run:** a run whose `started_at` is under 30 days old. Its evidence is fresh too, since `retrieved_at` is never earlier than `started_at`.
- **Enqueue failure at start:** the step deletes the run row it just created and throws, which counts as a failure. The next poll starts a new run, so a lost start never stalls the pick for 10 minutes.
- **Re-run** (`/rerun`): reuses the run and its fresh evidence. If the evidence has expired (30 days), the pick starts a new run (new `runId`, `seq` 0), just as an expired genre search is refetched today.
- **Shorts:** no research. They copy the parent's fields (R13).
- **Closing the browser** during the run doesn't stop it: deliveries come from the queue. The page reopens on the `PICK` wait or, once done, the draft.

## R4 · Peer discovery (FR-016, FR-018)

- **Query:** `search.list` with `part=snippet`, `type=video`, `videoCategoryId=10`, `order=relevance`, `maxResults=50`, and `q` = the analysis's top two genre terms (`genreTerms`) + `music`. Uses the API key, so no upload quota. Relevance, not `viewCount`: FR-016 chooses peers by sound and genre only.
- **Candidates:** distinct channel IDs in result order, excluding the owner's own channel and fresh `peer_rejections` (SC-003). The first 8 are kept (`PEER_CANDIDATES`).
- **Details:**
  - `channels.list(part=snippet,statistics,contentDetails)`: title, description, uploads playlist, and the statistics as reported, with `hiddenSubscriberCount` kept (unknown, never estimated).
  - For each candidate, its newest upload (`playlistItems` 1 + `videos.list contentDetails,snippet`): the sample to hear.
- **Rejections refresh:** at discover, `channels.list(id=<fresh rejected IDs>)` refreshes their `retrieved_at` (III.E.4.d "delete or refresh"). An ID YouTube no longer returns is deleted.
- **Quota:** about 104 units per run (search 100 + 4 reads); the genre search adds 100. That's about 50 jobs a day on the key's 10,000.
- **No peers outside the genre** (edge case): candidates come only from the genre query, and nothing widens it.

## R5 · Matching and hearing (FR-018, gate G1)

- **Agent `peer-match`:** one call per candidate on the analyst model (cheapest in use), `low` thinking, `mediaResolution: 'low'`, 2048 tokens, `minCallMs` from G1's p95.
  - Input: the artist's song digest (genre, instrumentation, mood, tempo feel from the windows), the candidate's channel title and description, and the sample's title and tags (tagged `source: 'youtube'`). Plus, when hearing is on, the sample as a YouTube watch URL clipped to its first 60 s (`providerOptions.google.processing = { type: 'static', startOffset: 0, endOffset: 60 }`).
  - Output: `{ channelKind: 'artist' | 'label' | 'compilation' | 'curator' | 'uncertain', sound: 'same' | 'different' | 'uncertain', explanation }`.
  - Kept only when the kind is `artist` and the sound is `same`. Anything uncertain is skipped (spec).
  - Basis: `heard` when the clip was part of the call, `metadata-only` otherwise, and labeled so (FR-018).
  - Stop after 5 peers (`PEER_LIMIT`). As many candidates as the deadline allows run per delivery.
- **Installed SDK (`@ai-sdk/google` 4.0.105, Interactions model):**
  - `supportedUrls['video/*']` includes `^https?://(www\.)?youtube\.com/watch\?v=.+`, so a YouTube URL file part is passed through rather than downloaded.
  - `getVideoProcessingField` maps `processing: { type: 'static', startOffset, endOffset }` to `start_offset`/`end_offset`.
  - `sdkPart` (`ai/model.ts`) sends inline bytes only today; a new `{ type: 'youtube', url }` part maps to a file part with `mediaType: 'video/mp4'` and that processing option.
- **Gemini docs:**
  - The YouTube URL feature "is in preview"; public videos only; the paid tier has no length limit; about 100 tokens per second of video at low resolution.
  - Clipping is documented for "static" processing, but **not confirmed for YouTube URLs**.
- **Gate G1 (constitution V; brief: the orchestrator runs it within $2 total, this spec's live share $0.50):** `specs/006-fanbase-learning/gates/g1/` (script + `result.json`), before any hearing code. Two calls on the analyst model, about $0.02. It must show:
  1. a public YouTube URL is heard through `generateText` with the Interactions model, and the reply describes its audio
  2. no request to `youtube.com` or `googlevideo.com` leaves our process: the SDK passed the URL through (a `fetch` wrapper logs hosts)
  3. a 60 s static clip bills in proportion to 60 s, not the whole video (`usage.inputTokens`)
  4. what a private or removed video returns (status, message), which maps to `metadata-only`
  5. latency for `minCallMs`
- **G1 fails:** hearing stays off (`PEER_HEARING` unset). Every match is `metadata-only` and labeled; FR-018 allows that. Nothing else changes.
- **AGENTS.md "NEVER send the model a URL"** (analyst clips) gains one scoped exception: a public YouTube watch URL of a peer's upload in `peer-match`. Never the artist's media.
- **Not downloading from YouTube (PRD non-goal):** Gemini fetches the video, not the app (G1 check 2).

## R6 · Peer releases and evidence (FR-005, FR-020)

- **Per peer:** `playlistItems` (10) + `videos.list(part=snippet,statistics,contentDetails)`.
- **Eligible:** a comparable release (spec Assumption, decided here from free metadata only, never statistics):
  - in the same YouTube length bucket as the upload (`durationBucket`, already used by the genre search: under 4 min, 4–20 min, over 20 min)
  - published at least 14 days and at most 3 years before retrieval
  - the first 3 eligible in upload order (`RELEASES_PER_PEER`), so ordinary releases sit beside successes (FR-005). Never chosen by views.
- **Evidence row:** one `job_research` row per job, `retrieved_at` = the earliest retrieval in the run. Never extended, like `job_audience`. It holds:
  - candidates (dropped once matched)
  - peers: `{ ref: 'P1', channelId, title, basis, explanation, stats }`
  - releases: `{ ref: 'P1-R1', peer: 'P1', videoId, title, description (700 chars), tags, hashtags, durationSec, publishedAt, stats }`
  - `skipped`: `{ channelId, reason }`
- **Pick inputs:**
  - **Structure:** peer releases replace `audienceTopVideos` (FR-020). With no peers, the genre search's top videos stay, and the limit line says so.
  - **Candidates:** each eligible peer release becomes its own `CandidateList` (`rankHashtags`, `rankTags`), labeled `P1-R1`, beside the genre lists `G1…G10`. Never merged, counted or weighted (III.E.2.a). Approval membership is the union of the job's fresh lists, as today.
  - **Statistics never enter a prompt** (PRD R4 keeps that rule for peers). They're shown in review as YouTube reports them (FR-016).
- **Prompt volume:** at most 5 × 3 = 15 peer lists + 10 genre lists, each capped at 30 hashtags and 40 tags as today.

## R7 · Brackets behind a flag (FR-016–FR-019)

- **Flag:** `BRACKETS_ENABLED`, unset everywhere (brief). Turning it on needs YouTube's acceptance of the derived-metrics amendment **and** a constitution amendment: Platform Terms forbids grouping channels by statistics.
- **Off (shipped):**
  - peers chosen by sound and genre only (R4, R5)
  - statistics shown as reported, unranked and ungrouped
  - the limits line always says "Bracket targeting is unavailable until YouTube approves derived metrics." (FR-016)
  - no subscriber count read for the artist's own channel beyond today's header
- **On (built and tested, never run in production):**
  - `bracketOf(subscriberCount | null)`: decade ranges `[0,100) [100,1k) [1k,10k) [10k,100k) [100k,1M) [1M,∞)`, the same boundaries for the artist and peers (FR-017). A hidden or missing count → `null`, unknown (edge case).
  - `relation(artist, peer)`: `same | next | two-up | other`. `other` and unknown are dropped. Nothing further up is used (FR-018).
  - Selection: next-bracket peers first; with fewer than 3 next-bracket peers, same-bracket peers fill in, and the limits line says "Fell back to same-range artists". Two-up peers are labeled secondary.
  - The server rejects a recommendation whose `evidence` cites only two-up peers; it's treated like an influence mismatch (R12).
  - Views and engagement select releases (FR-017, simple arithmetic only, never a combined score). Review shows the current and target ranges. A bracket changes only when the reported count crosses a boundary (FR-019; a pure function, so single-release spikes can't move it).
- **Why build it now:** brief decision. It's isolated in `src/lib/server/research/brackets.ts` plus one branch in selection, so turning it on is configuration plus governance, not a new design.

## R8 · Learning from the artist's results (FR-001, FR-004, FR-007, FR-010, FR-015)

- **Stage `learn`, only when analytics is shared (R9):**
  1. `accessTokenFor(uid, channelId, deadline)`, then `ownUploads(token, channelId, 20, deadline)` extended to `part=snippet,status`. This covers releases from before Soundboard (FR-004).
  2. **Public only:** private and unlisted uploads are skipped and counted in the limits ("N releases are still private"). Upload verification is never read as performance (edge case).
  3. Per public upload, one `reports.query`:
     - `ids=channel==MINE`, `metrics=views,subscribersGained,subscribersLost`, `dimensions=video`, `filters=video==<id>`
     - `startDate` = publish date, `endDate` = start + 27 days, capped at today
     - Window still open → `partial`.
     - A fixed first-28-day window keeps releases of different ages comparable (edge case).
     - At most 20 calls.
  4. Upsert `artist_outcomes` by `(artist_id, video_id)`. A revised report replaces the earlier one, so nothing is double-counted (FR-010).
  5. Live metadata (title, description clipped to 700, tags) is compared with the publish record's `finalFields`; `differsFromApproved` flags a Studio edit (edge case).
- **Reported as returned:** views, subscribers gained and subscribers lost, never a net figure (subtraction is a calculation, FR-010). Gained is labeled "subscriptions on this video's page, a lower bound" (edge case). Views are reach, not fans (FR-001).
- **Adopted (FR-007):** `recordVerified` adds `recommendation` (approach, intended outcome, evidence refs) and `influence` to the publish record. That's app output, kept as long as the publish. Outcomes join to publishes by `videoId`. A Short is its own publish with `recommendation: null` and separate outcomes (edge case).
- **No stored "lessons":** each pick reads fresh outcomes plus adopted publishes and reasons again. Long-term learning keeps only those two, as FR-015 requires.
- **Without consent:** no Analytics call; `limits += 'analytics-not-shared'`; outcomes unknown; approval unaffected (FR-002).
- **Grant missing or refused during learn:** `access.refused` as in 004 R8, `limits += 'youtube-not-connected'`, the stage advances. The pick itself still waits on `reconnect YouTube` (004), so constitution III holds.

## R9 · Analytics consent and the OAuth scope (FR-002)

- **Scope (brief):** `https://www.googleapis.com/auth/yt-analytics.readonly`, requested only through a new optional "Share analytics" connect, never at sign-in. `YOUTUBE_SCOPES` (the required pair) is unchanged, so `connectGrant`'s required check and every approval rule stay as they are.
- **Why both scopes are documented-safe:** the `reports.query` page lists `yt-analytics.readonly` and also says "API requests to this method now require access to the `youtube.readonly` scope". The app already holds `youtube.readonly`. Holding both is the documented combination, so no gate is needed for scopes.
- **Flow:**
  - `/auth/login?connect=analytics` → `OAuthState.purpose = 'analytics'`
  - `authUrl` with `SCOPES + ANALYTICS_SCOPE`, `include_granted_scopes: true` (already set), `prompt: 'select_account consent'`, `login_hint`
  - the callback reuses `connectGrant(uid, grant, 'connect')`, which stores the new refresh token and scopes; a grant missing a required scope never replaces a connected row
- **Shared** means `connections.scopes` includes the analytics scope. Unticking it on Google's granular consent screen leaves it unshared, and nothing breaks.
- **Stop sharing:** Google can't revoke one scope. Disconnect revokes the whole grant, and outcomes are deleted then (R10). Connections says so.
- **Verification:**
  - The scopes reference doesn't print a sensitivity class. The OAuth console classifies a scope when it's added to Data Access.
  - The app is already "In production" and unverified with `youtube.upload` and `youtube.readonly` (PRD R10). The unverified-app screen and the permanent 100-new-user cap already apply.
  - Adding another unapproved scope keeps that state. It forces no verification now and isn't a restricted scope.
  - When the owner submits verification (PRD Open Questions), this scope must be listed and justified, as must the YouTube API audit (`docs/youtube-audit/`).
  - Operator steps (not run): add the scope to Data Access, and enable `youtubeanalytics.googleapis.com` in the OAuth client's project (`deploy.sh`).
- **Gate G2 (live, dev OAuth client, non-Nathan test channel, $0 Gemini):** share analytics, then one `reports.query` for one public upload. Record the response shape, a no-data video (no rows → unknown), and the error for a token without the analytics scope (→ `analytics-not-shared`). Google's consent click is the owner's (👤).

## R10 · YouTube terms and retention (FR-012, FR-015, SC-008)

- **Every stored YouTube datum carries `retrieved_at`, is hidden by RLS at 30 days on the database clock, and is deleted daily by `genrecleanup`:**

| Table                                   | Kind (Developer Policies)                                  | Refresh                                                               |
| --------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `job_research` (peers, releases, stats) | Non-Authorized (III.E.4.d)                                 | a new run after expiry                                                |
| `artist_outcomes`                       | Authorized: Analytics (III.E.4.b) and metadata (III.E.4.c) | every learn stage; authorization rechecked by the live grant (FR-015) |
| `peer_rejections`                       | channel IDs, Non-Authorized                                | every discover stage (R4)                                             |

- III.E.4.b would let Analytics data live longer with a 30-day authorization check. FR-015 and Platform Terms keep it to 30 days anyway (stricter, owner's rule).
- **Spec conflict, resolved for the terms:** FR-015 says citations "keep the peer reference but not its statistics" after 30 days. Developer Policies have no exemption for channel or video IDs (III.E.4.d, the same finding as 004 R13). So a long-lived citation stores only an internal reference (`job_research` + `P1`), never a name or ID.
  - While fresh, review resolves it to the peer's name and statistics.
  - After expiry, review shows "Peer evidence expired on <date>".
  - The spec says terms win ("YouTube API policies MUST NOT be violated"). Recorded as owner question Q1.
- **No peer names in long-lived text:**
  - The prompt tells the model to refer to peers only by ref.
  - `finalizePick` replaces any peer channel title in the recommendation text with its ref.
  - A peer title in a draft field (title, description, Bandcamp) counts as a copy (R12).
- **Revocation (III.D.2.c):** a `connections` trigger deletes the artist's `artist_outcomes` in the same transaction when sharing ends. That covers Disconnect (`revokeGrant`), a detected revocation (`markRevoked`) and a reconnect without the scope, well inside 7 days. The platform folder never touches artist tables (constitution IV).
- **No aggregation (III.E.2.a, SC-008):** no code sums, averages or counts statistics across channels. Peer lists stay separate. A test scans the pick prompt and review data for cross-peer totals.
- **No calculated numbers (FR-010):** nothing is computed from statistics while the flag is off. Model numerics are stripped (`stripDeep`).
- **Stale spec assumption:** "Genre-search statistics already stored on jobs have no expiry … tracked in TTD.md." That was already fixed by `job_audience`, `job_audience_fresh` and migrations 0001–0003 (`docs/operations/youtube-retention.md`). `TTD.md` doesn't exist. Nothing to do.

## R11 · Sliders: storage, defaults, and the 005 open question (FR-021, FR-023, FR-025)

- **Shape:** `Influence = { sound, feel, wording, discovery, structure }`, each an integer 0–4. 0 means no peer influence, 4 the strongest, and 1–3 blend. The level is relative, not a word percentage (FR-021).
- **Defaults (no setup, FR-021 table):**

| Role      | Default | Why                                                                                            |
| --------- | ------- | ---------------------------------------------------------------------------------------------- |
| Sound     | 1       | song analysis, with peer vocabulary helping describe it                                        |
| Feel      | 0       | the artist's own writing and edits                                                             |
| Wording   | 0       | the artist's phrasing                                                                          |
| Discovery | 4       | peer tags, limited to what was heard                                                           |
| Structure | 4       | peer patterns for length and order; identity and credit lines are always the artist's (FR-025) |

- **Storage:** `artist_guides.influence jsonb`, `CHECK (influence is null or (kind = 'brand' and status = 'approved'))`, plus a shape check. Written only through `soundboard_save_influence(p_influence)`.
  - 005's `guides_update` `WITH CHECK` requires `proposed_at` within 30 days, so a plain update to an older approved row would fail. The function avoids that.
  - It locks the caller's `users` row and updates their approved brand row. 0 rows → `409`.
  - 005's approve rewrites only four columns, so a new approval keeps the sliders.
- **005 Q2, decided: defaults apply, and saving needs an approved brand guide.**
  - Settings shows the sliders at the defaults (or the saved values).
  - Without an approved brand guide, Save is disabled with "Approve your brand guide to save your own settings. Drafts use these defaults until then." and a link to Brand.
  - Why not create a minimal row: an "approved" brand row the artist never approved breaks 005 FR-005 and FR-006 ("Only an approved … brand guide MUST affect picks"; without one, "picks MUST run without one"), and every reader would need a special case.
  - Why not `artists.influence`: it breaks 005 FR-012 and 006 FR-023 ("with their brand guide") for one saved click.
  - Cost: an artist who wants custom sliders approves a brand guide first (under 5 minutes, 005 SC-001). Nathan already has one (005 migration). Owner question Q2 offers the `artists.influence` alternative.
- **Per draft (FR-023):** `pick.influence` stores the settings used. Changing defaults never touches a stored pick (test).
- **Learning never writes `influence`** (FR-025): only the artist's `PUT /api/influence` does (test).

## R12 · Pick: sources, citations, influence check, copy check (FR-006, FR-008, FR-009, FR-022, FR-024, FR-025)

- **Source refs in the prompt** (each YouTube-sourced part tagged `source: 'youtube'`):
  - `analysis`
  - `voice` (approved voice or `GENERIC_VOICE`), `edits` (Soundboard feedback, labeled preference, FR-009), `identity` (own recent uploads)
  - `A<n>` the artist's outcomes (with `adopted` and `editedAfterApproval`); the pick keeps `outcomeRefs` (`A<n>` → the artist's own video ID) so review can resolve them while the outcome is fresh
  - `P<n>` peers, `P<n>-R<m>` peer releases
  - `G<n>` genre lists
- **Classes:** peer = `P*`; everything else is non-peer.
- **Allowed per role** (US1 AS2):

| Role      | Non-peer sources                      | Peer sources  |
| --------- | ------------------------------------- | ------------- |
| Sound     | `analysis`                            | `P*`          |
| Feel      | `voice`, `edits`                      | `P*`, `P*-R*` |
| Wording   | `voice`, `edits`                      | `P*`, `P*-R*` |
| Discovery | `G*`, `analysis`                      | `P*-R*`       |
| Structure | `identity`, `G*` (only when no peers) | `P*-R*`       |

- **Output additions:**
  - `citations: { sound, feel, wording, discovery, structure: string[] }`
  - `recommendation: { approach, intendedOutcome, evidence: string[], follows: 'artist' | 'peers' | 'both' | 'none', followsWhy }`
  - Unknown or disallowed refs are dropped by the server.
- **Influence check (FR-024), server-side after the reply:**
  - level 0: no peer ref for that role
  - level 4: at least one peer ref; wording and feel need refs from at least 2 distinct peers (FR-022)
  - levels 1–3: at least one peer ref and one non-peer ref
  - Evidence the setting needs but the job lacks (no peers, fewer than 2 for wording/feel at 4) isn't a mismatch. It becomes a limit ("No peer evidence for wording at this setting"), with no retry and the saved setting unchanged (edge case).
  - A real mismatch gets a re-ask naming the failing roles, if `hasModelTime` allows. Still mismatched, or no time → stored with `influenceWarning: 'Influence settings not met'`. Review shows it and doesn't block (FR-024).
  - **One re-ask per pick** covers both checks: it names the failing roles and the copied runs together, so the shared 110 s deadline holds at most two pick calls.
  - Deliberate peer influence never triggers a voice warning: `brandCheck` stays about the brand guide only.
- **Copy check (FR-022, constitution II), deterministic:**
  - normalize: lowercase, words only
  - a run of 6+ consecutive words shared with any single peer title, description or channel description is a copy
  - so is any peer channel title appearing in a draft field
  - runs made only of candidate tag or hashtag terms, the song title or the artist name don't count: shared genre vocabulary is allowed (edge case)
  - the shared re-ask (above); still copied → the pick throws, counts as a failure, and a retry re-picks (PRD R5's repeat-of-skipped pattern)
- **Prompt rules added** (FR-006, FR-008, FR-009, US2 AS3, AS5):
  - the slider level text per role
  - artist outcomes are fans and reach; peer evidence is reach only
  - repeated comparable artist outcomes outrank loose peer observations, and heard peers outrank metadata-only
  - tactics are tentative, never causes
  - feedback is preference, not audience success
  - when artist and peer evidence conflict, say which is followed and why (`followsWhy`)
  - with sparse evidence, say so rather than invent success
- **Facts unchanged (FR-025):** `finalizePick`'s tag, hashtag, numeric, length, link and contact rules run after every setting.

## R13 · Recommendation, adoption and review (FR-006, FR-007, FR-013, FR-014, SC-004, SC-007)

- **`pick.recommendation`:** the model's approach, intended outcome, `follows` and evidence refs, plus server-built `limits[]` (never the model's, like flags):
  - the bracket line (always, while off)
  - `analytics-not-shared`, `youtube-not-connected`, private releases
  - too few peers, research didn't finish
  - per-role unavailable evidence
- **Review:**
  - Each field screen's "Why this" lists that field's cited sources.
  - The Approve summary adds a Recommendation block: approach, intended outcome, limits, influence warning.
  - A Peers disclosure: each peer's name, `heard` or "metadata only" label, explanation, statistics exactly as reported with the retrieval date, and a **Not a peer** button.
  - No form, no extra step, no new required action (FR-014, SC-007).
- **Not a peer:** `POST /api/jobs/{id}/peers/{ref}/reject` → `soundboard_reject_peer(channelId)` keyed to the job's artist. Later runs exclude the peer; this job's re-runs drop its sources from the prompt.
- **Short selection (FR-013 MAY):** not used. The hook prompt is unchanged (YAGNI).

## R14 · Model settings and Sentry

- New agent `peer-match` (R5). The smart pick keeps its settings, with more prompt input and the citations and recommendation output.
- **Sentry:** every YouTube-sourced part is replaced by a placeholder in `invoke_agent` and `chat` spans: peer metadata `[YouTube peers: <n>]`, releases `[YouTube releases: <n>]`, outcomes `[YouTube outcomes: <n>]`, the hearing URL `{ type: 'video', source: 'youtube' }`. 004 R13 generalizes from one label to `source: 'youtube'` plus a `label`. Replies are kept, as AGENTS.md requires.
- **Research spans:** each delivery is one `research.stage` span tagged with `job.id` and stage. Search is an `execute_tool peer_search` span; Analytics is `execute_tool analytics_report`. Never the token or the OIDC JWT.

## R15 · Cost and the live budget

- **Per job, added by 006:** up to 8 `peer-match` calls (about 6k tokens each with a 60 s low-resolution clip, analyst prices) plus about 15k more pick input tokens on Argon. Roughly $0.05.
- **Live validation share: $0.50** (brief), logged in the run's Gemini ledger before each call:

| Call                                                      | Est.        |
| --------------------------------------------------------- | ----------- |
| G1, 2 `peer-match` calls                                  | $0.02       |
| 1 analyze window (≤ 60 s test video)                      | $0.01       |
| 8 `peer-match` calls                                      | $0.03       |
| brand proposal for the test artist (sliders need it, R11) | $0.05       |
| pick at default sliders                                   | $0.10       |
| re-run at wording 4                                       | $0.10       |
| **Total**                                                 | **≈ $0.31** |

- Stop at the share. A spent share leaves the remaining quickstart steps unverified and says so.

## R16 · Test scope

- **Unit (PGlite, real migrations; Sentry global mock; `fetch` mocked for YouTube Data, YouTube Analytics, Gemini, Cloud Tasks and Google certs; `google-auth-library` and KMS at the boundary):**
  - migration: tables, checks, RLS (own, fresh, expired hidden), cleanup role, the five write functions, the shape helper and the trigger
  - retention deletes and counts
  - queue: REST shape, named-task dedupe, dev path, build throws
  - task endpoint: OIDC accept and reject, stale `seq`, held claim → 503, enqueue failure → 500
  - each stage: positive, waits, errors, deadline threading, idempotent redelivery
  - discovery filters and rejections refresh; match keep/skip and labels; release eligibility
  - brackets with the flag on and off
  - learn: public-only, 28-day window, revised report replaces, Studio-edit flag, no consent, revoked
  - sliders API and storage; pick prompt, citations, influence check, copy check
  - recommendation limits; adoption on verify; revocation deletes outcomes; no peer names or IDs in `jobs` or `artist_memory`
  - the page load never creates a run
- **E2E (both projects, Pixel 7 primary):**
  - the research wait on the working screen
  - a seeded finished run renders the recommendation, peers with statistics and labels, and Not a peer
  - Settings sliders: save with a brand guide, disabled without one
  - Connections "Share analytics" link
  - an expired-evidence citation
- **Not automated:** Gemini's match quality and recommendation quality (quickstart, SC-005), Cloud Tasks delivery in GCP (post-deploy check, never run here), Google's consent screen.

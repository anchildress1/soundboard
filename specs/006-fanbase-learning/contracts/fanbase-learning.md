# Contract: fanbase learning

Interfaces this feature adds or changes. Shapes are in [data-model.md](../data-model.md), and the reasoning is in [research.md](../research.md).

## `POST /api/research/task` (Cloud Tasks only)

- **Gate:** exempt from the session gate (`hooks.server.ts`), POST only. It authenticates itself (research R2).
- **Auth:** `Authorization: Bearer <Google OIDC ID token>`, verified with `aud = RESEARCH_TASK_URL`, `email = RESEARCH_TASK_SA`, `email_verified = true`. Otherwise `401`, nothing read or written. No session cookie is read.
- **Body:** `{ "jobId": string, "uid": string, "runId": string, "seq": number }`. Wrong shape → `400`.
- **Runs** under `withIdentity(uid)`; the claim matches `jobId`, `runId`, `uid` and `seq` together against the row, and the job must not be discarded.
- **Responses:**
  - `200 {}`: a batch ran and committed (and the next task was enqueued), or the delivery was stale (finished, failed, discarded or replaced run, lower `seq`, inactive owner, missing job, lost claim at commit)
  - `503`: the claim is held, or the task's `seq` is ahead of the row
  - `500`: the next enqueue failed; nothing was written
- Never returns run contents, evidence, tokens or errors in the body.

## Cloud Tasks task (created by the app)

```json
{
  "task": {
    "name": "projects/<p>/locations/us-central1/queues/soundboard-research/tasks/<runId>-<seq>",
    "scheduleTime": "<RFC 3339, when waiting>",
    "dispatchDeadline": "180s",
    "httpRequest": {
      "httpMethod": "POST",
      "url": "<RESEARCH_TASK_URL>",
      "headers": { "Content-Type": "application/json" },
      "body": "<base64 of the Delivery JSON>",
      "oidcToken": {
        "serviceAccountEmail": "<RESEARCH_TASK_SA>",
        "audience": "<RESEARCH_TASK_URL>"
      }
    }
  }
}
```

- `409 ALREADY_EXISTS` on create is success (dedupe).
- The token fetch and the request run under the caller's step deadline.
- Env: `RESEARCH_QUEUE` (the queue's full name), `RESEARCH_TASK_URL` (`https://soundboard-<project number>.us-central1.run.app/api/research/task`), `RESEARCH_TASK_SA`. With `RESEARCH_QUEUE` unset, dev runs deliveries in-process and a build throws.

## `POST /api/jobs/{id}/step` (PICK behavior)

- **No fresh run** (none, `failed`, or `started_at` 29+ days old): creates `research_runs` (stage `learn`), enqueues `<runId>-0`, returns `{ wait: 'researching similar artists' }`. If the enqueue fails or is ambiguous, the run is marked `failed` (`research-unavailable`) and the pick runs in the same step without peers. Never a step failure.
- **Run running**, under 10 minutes since `started_at`: `{ wait: 'researching similar artists' }`. Nothing else runs.
- **Run `done`, `failed`, or past 10 minutes:** the pick runs, plus peer evidence, outcomes, sliders, citations, the checks and the stat guard. One re-ask per pick covers every check; a copy that survives it is a step failure.
- Owner grant and profile waits from 004 are unchanged and come first.

## Page loads

- `GET /jobs/{id}` and every other page load read state only. They never create or enqueue a run (US3 AS4).

## Review data (`/jobs/{id}` page data, artist's own job)

- `pick.recommendation`: `{ approach, intendedOutcome, follows, followsWhy, evidence, limits }` or `null` with a limit explaining why.
- `pick.citations` per role, resolved for display; `pick.influence` and `pick.influenceWarning`.
- `ranges`: `{ current, target }` as reported-count ranges, or `null` when the artist's count is hidden.
- `peers` from `job_research` where `run_id = pick.researchRunId` and fresh, else `null`:
  - each `{ ref, title, basis, secondary, explanation, relation, stats: { subscribers | 'hidden' | null, videos, views }, retrievedAt, releases: [{ ref, title, url, selectedAs, stats: { views, likes, comments }, engagement: Calculated, publishedAt }] }`
  - reported statistics exactly as returned; `engagement` labeled "calculated"; peers in selection order (next, same, two-up); nothing totaled across channels
- An expired or unknown `P*` ref resolves to `{ ref, expired: true, expiresAt: pick.evidenceExpiresAt }`. The UI shows "Peer evidence expired on <date>".
- An `A*` ref resolves through `pick.outcomeRefs` to a fresh, shared `artist_outcomes` row: `{ ref, title, requested: { start, end }, coverage, metrics, net: Calculated }`, labeled "Your results (YouTube Analytics)". Expired, deleted or not shared → `{ ref, expired: true }`, shown as "Result no longer stored".
- Labels: peer statistics "Public reach on YouTube"; subscribers gained "on this video's page; a lower bound"; calculated values "calculated"; coverage `open` "still collecting", `unknown` "may be incomplete".

## `POST /api/jobs/{id}/approve` (changed pool)

- Allowed tags and hashtags: the job's fresh genre lists plus the fresh peer release lists of `pick.researchRunId`. When either pool has expired, the stored draft's own selected terms stay allowed. Same for a Short, through its copied pick.

## `POST /api/jobs/{id}/discard` (changed)

- Also marks the job's run `failed` (`discarded`) and clears its claim, in the same transaction.

## `POST /api/jobs/{id}/peers/{ref}/reject`

- `authorizedJob` (404 for another user's job). Artist job only, else 404.
- `ref` must be a fresh `P*` of the pick's `researchRunId` → `soundboard_reject_peer(channelId)`. Unknown or expired → `409 "That peer's evidence has expired. Reload to see it."`
- `200 { rejected: ref }`. Later runs skip the channel; this job's re-runs leave its sources out.

## `PUT /api/influence`

- Signed in with a profile, else `401` or `404` (`requireArtist`).
- **Body:** `Influence`. Invalid → `422` with "Each setting is a whole number from 0 to 4."
- No approved brand guide → `409 "Approve your brand guide to save your own settings."`
- `200 { influence }`. Applies to later picks and re-runs. Stored picks don't change.

## `/settings` page

- **Load:** `{ influence, saved, canSave }`; `influence` is the saved value or `DEFAULT_INFLUENCE`; `canSave` = an approved brand guide exists.
- One range input (0–4) per role, labeled with the role and its default source, ends "Your own" and "Strongest peer".
- Save is disabled when `!canSave`, with "Approve your brand guide to save your own settings. Drafts use these defaults until then." and a link to Brand. Plain labels only.

## `/connections` page and `/auth/login?connect=analytics`

- **YouTube row:** "Analytics: Shared" or "Analytics: Not shared". When not shared and connected, a **Share analytics** link to `/auth/login?connect=analytics`.
- **Note:** "Stop sharing by disconnecting YouTube; Soundboard deletes your stored results."
- **Login:** `?connect=analytics` needs a session (`401` otherwise). State purpose `analytics`; scopes = sign-in scopes + `yt-analytics.readonly`; `prompt=select_account consent`; `login_hint`.
- **Callback:** same session, nonce and expiry checks as `connect`, then `connectGrant(uid, grant, 'connect')`. Redirects to `/connections?analytics=shared` or `?analytics=declined`. A connected row is never downgraded.

## Disconnect and revocation

- Disconnect, `markRevoked`, and a reconnect without the analytics scope delete the artist's `artist_outcomes` through the `connections_forget_outcomes` trigger. A report still in flight can't be saved afterwards (data-model). The routes don't change.

## Retention job

- `functions/genrecleanup.ts` → `{ "deleted", "proposals", "research", "outcomes", "rejections" }`. Same trigger, same slug, `soundboard_cleanup` only.

# Contract: fanbase learning

Interfaces this feature adds or changes. Shapes are in [data-model.md](../data-model.md), and the reasoning is in [research.md](../research.md).

## `POST /api/research/task` (Cloud Tasks only)

- **Gate:** exempt from the session gate (`hooks.server.ts`), POST only. It authenticates itself (research R2).
- **Auth:** `Authorization: Bearer <Google OIDC ID token>`. The token must verify, with `aud = RESEARCH_TASK_URL`, `email = RESEARCH_TASK_SA` and `email_verified = true`. Otherwise `401`, nothing read or written. No session cookie is read.
- **Body:** `{ "jobId": string, "uid": string, "runId": string, "seq": number }`. Wrong shape → `400`.
- **Runs** under `withIdentity(uid)`, so RLS limits it to that owner's rows.
- **Responses:**
  - `200 {}`: the stage ran and was released (and the next task enqueued), or the delivery was stale (finished or replaced run, lower `seq`, inactive owner, missing job)
  - `503`: the claim is held, or the task's `seq` is ahead of the row. Cloud Tasks retries.
  - `500`: the next enqueue failed; nothing advanced. Cloud Tasks retries.
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
- Env: `RESEARCH_QUEUE` (the queue's full name), `RESEARCH_TASK_URL`, `RESEARCH_TASK_SA`. With `RESEARCH_QUEUE` unset, dev runs deliveries in-process and a build throws (research R2).

## `POST /api/jobs/{id}/step` (PICK behavior)

- **First call with no fresh run:** creates `research_runs` (stage `learn`), enqueues `<runId>-0`, returns `{ wait: 'researching similar artists' }`. An enqueue failure deletes that new run and is a step failure; the next call starts a new run.
- **Run running** (under `RESEARCH_MAX_MS` = 10 min since `started_at`): `{ wait: 'researching similar artists' }`. Nothing else runs.
- **Run `done`, `failed`, or past 10 minutes:** the pick runs as today, plus peer evidence, sliders, citations, the influence check and the copy check. Waits and failures are as today; one re-ask per pick covers both checks; a copy that survives it is a step failure.
- Owner grant and profile waits from 004 are unchanged and come first.

## Page loads

- `GET /jobs/{id}` and every other page load read state only. They never create or enqueue a run (US3 AS4).

## Review data (`/jobs/{id}` page data, artist's own job)

- `pick.recommendation`: `{ approach, intendedOutcome, follows, followsWhy, evidence, limits }`. Evidence refs resolve as below.
- `pick.citations` per role, resolved for display.
- `pick.influence` (the settings used) and `pick.influenceWarning`.
- `peers` (from fresh `job_research`), or `null` when expired or absent:
  - each `{ ref, title, basis, explanation, stats: { subscribers | 'hidden' | null, videos, views }, retrievedAt, bracket?, releases: [{ ref, title, url, stats, publishedAt }] }`
  - statistics exactly as reported, never ranked, sorted or totaled
  - `bracket` only with `BRACKETS_ENABLED`, which also adds `ranges: { current, target }`
- An expired or unknown `P*` ref resolves to `{ ref, expired: true, retrievedAt }`. The UI shows "Peer evidence expired on <date>".
- An `A*` ref resolves through `pick.outcomeRefs` to a fresh `artist_outcomes` row: `{ ref, title, period: { start, end }, partial, metrics }`, labeled "Your results (YouTube Analytics)". Expired or deleted → `{ ref, expired: true }`, shown as "Result no longer stored".
- Labels: peer statistics "Public reach on YouTube"; the artist's outcomes "Your results (YouTube Analytics)"; subscribers gained "on this video's page; a lower bound".

## `POST /api/jobs/{id}/peers/{ref}/reject`

- `authorizedJob` (404 for another user's job). Artist job only, else 404.
- `ref` must be a fresh `P*` in this job's research → `soundboard_reject_peer(channelId)`. Unknown or expired → `409 "That peer's evidence has expired. Reload to see it."`
- `200 { rejected: ref }`. Later runs skip the channel. This job's re-runs leave its sources out.

## `PUT /api/influence`

- Signed in with a profile, else `401` or `404` (`requireArtist`).
- **Body:** `Influence`. Invalid → `422` with `influenceError`'s message ("Each setting is a whole number from 0 to 4.").
- No approved brand guide → `409 "Approve your brand guide to save your own settings."`
- `200 { influence }`. Applies to later picks and re-runs. Stored picks don't change.

## `/settings` page

- **Load:** `{ influence: Influence, saved: boolean, canSave: boolean }`. `influence` is the saved value or `DEFAULT_INFLUENCE`; `canSave` = an approved brand guide exists.
- **Peer influence:** one range input (0–4) per role, labeled with the role and its default source, ends "Your own" and "Strongest peer".
- **Disabled save:** Save is disabled when `!canSave`, with "Approve your brand guide to save your own settings. Drafts use these defaults until then." and a link to Brand.
- The existing line about what settings never override stays. Plain labels only.

## `/connections` page and `/auth/login?connect=analytics`

- **YouTube row:** "Analytics: Shared" or "Analytics: Not shared". When not shared and connected, a **Share analytics** link to `/auth/login?connect=analytics`.
- **Note:** "Stop sharing by disconnecting YouTube; Soundboard deletes your stored results."
- **Login:** `?connect=analytics` needs a session (`401` otherwise), like `connect=youtube`. State purpose `analytics`; scopes = sign-in scopes + `yt-analytics.readonly`; `prompt=select_account consent`; `login_hint`.
- **Callback:** same session, nonce and expiry checks as `connect`, then `connectGrant(uid, grant, 'connect')`. Redirects to `/connections?analytics=shared` when the scope was granted, else `/connections?analytics=declined`. A connected row is never downgraded.

## Disconnect and revocation

- Disconnect, a detected refusal (`markRevoked`), and a reconnect without the analytics scope delete the user's artist's `artist_outcomes` in the same transaction, through the `connections_forget_outcomes` trigger (III.D.2.c). The routes don't change.

## Retention job

- `functions/genrecleanup.ts` → `{ "deleted", "proposals", "research", "outcomes", "rejections" }`. Same trigger, same slug, still `soundboard_cleanup` only.

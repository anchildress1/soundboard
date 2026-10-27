# YouTube genre-search retention

- `job_audience` holds search evidence and its original retrieval time; job JSON holds no research cache.
- All evidence reads use the `job_audience_fresh` view, which excludes evidence at least 30 days old using the database clock. Re-picking refreshes expired evidence; retries and Shorts preserve the original retrieval time.
- Migration `0001` discards legacy research because its retrieval time was never recorded; artist drafts remain available.
- Migration `0002` rejects embedded research at the database write boundary so an older app revision cannot restore it during deployment.
- After expiry, approval accepts the draft's own selected tags and hashtags, not the expired candidate pool.
- Migration `0003` discards incompatible single-list research and adds the freshness view; drafts survive, and expired rows remain inaccessible before daily deletion.
- Each eligible video supplies a separate labeled list of first-seen unique terms. No cross-video merging, counts, ranking, or weighting; approval uses union membership only. Examples preserve YouTube search order, and view counts never enter candidate logic or model prompts.

## Fanbase learning tables

Migration `0007` adds three tables of YouTube data. Each row carries its retrieval time, is hidden from the app at 29 days on the database clock, and is deleted by the daily run, so deletion always lands before day 30.

| Table             | Holds                                                           | Refreshed                                                |
| ----------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| `job_research`    | A run's peers, their releases and statistics, as reported       | Never; a new run after expiry writes a new row           |
| `artist_outcomes` | The artist's own results for public uploads (YouTube Analytics) | Each learn stage, while analytics sharing is on          |
| `peer_rejections` | Channel IDs the artist marked "Not a peer"                      | Each discover stage; unseen for 29 days, it is forgotten |

- `research_runs` holds run state only (stage, cursor, claim, limits) and no YouTube data. See [the runner guide](research-runner.md).
- Evidence is keyed by run, not by job. A replaced run's evidence stays until it expires, so an older draft's citations still resolve, then read as expired with the date the pick recorded.
- Sharing analytics is the optional `yt-analytics.readonly` grant. A database trigger deletes the artist's `artist_outcomes` when it ends: Disconnect, a detected revocation, or a reconnect without the scope.
- Saving outcomes also checks that the connection row still shows the same grant (`updated_at`), so a report that was in flight when sharing ended writes nothing.
- Reads of `artist_outcomes` also require analytics to be shared now.

## Daily deletion on Neon

Run migrations before deploying the cleanup function. Deployment is separate from the app release; the schedule must be enabled on the intended Neon branch.

```sh
pnpm dlx neon@8.10.3 functions deploy genrecleanup \
  --src functions/genrecleanup.ts --runtime nodejs24 \
  --project-id <project-id> --branch <branch-id>

pnpm dlx neon@8.10.3 triggers create \
  --function-slug genrecleanup --name genre-evidence-retention \
  --cron '0 3 * * *' --project-id <project-id> --branch <branch-id>
```

- Neon injects that branch's `DATABASE_URL`; do not embed credentials in source or command arguments.
- Only Neon's scheduled POST invocations are accepted; the trusted trigger header is supplied by Neon's hosting edge.
- The database clock determines expiry; the request body cannot choose a deletion cutoff.
- A daily run at 03:00 UTC deletes expired rows even when the app is idle and the database has scaled to zero.
- Child branches inherit schedules disabled; confirm the trigger is enabled on the deployment branch.
- The same run deletes voice and brand proposals 29 days after their claim, so no proposal, or the upload list it read, outlives 30 days. Approved guides hold counts only and are never deleted by it.
- A missed daily run breaks that 30-day bound for proposals as well as statistics; investigate any gap in the schedule the same day.
- The same run deletes expired `job_research`, `artist_outcomes` and `peer_rejections` rows.
- Verify an actual invocation in Neon logs and confirm its response reports every count: `deleted` for genre evidence, `proposals`, `research`, `outcomes` and `rejections`. An unsuccessful run returns HTTP 500 and must be investigated.
- Redeploy `genrecleanup` before, or with, the first app revision that serves voice or brand proposals or runs research; an older function never deletes those rows.
- Local tests prove SQL deletion and request handling, not that a remote schedule has been provisioned.

## Database roles

- Run migrations with the owner credential in `DATABASE_URL_UNPOOLED`; never derive it from the restricted runtime URL.
- The invite script also reads `DATABASE_URL_UNPOOLED`; ordinary app credentials cannot invite, revoke, reactivate, or list other accounts.
- The app's `DATABASE_URL` must log in as `soundboard_app`, which owns no objects and has no role memberships or RLS bypass; an incorrectly privileged runtime connection fails closed.
- After switching the runtime, disable old owner-credential versions of its secret; secret access otherwise includes those historical versions.
- Deploy `genrecleanup` with both `DATABASE_URL` and `DATABASE_URL_UNPOOLED` overridden to the branch's `soundboard_cleanup` credential; never leave the injected owner credential as its runtime connection.
- `soundboard_cleanup` can read only expired job IDs and retrieval times and delete those rows; it cannot read evidence, jobs, connections, or artist memory. On the three fanbase tables it sees only keys and retrieval times.
- For proposals it sees only `(id, status, proposed_at)` of rows already past 29 days, never their text, upload lists, or claims.
- RLS hides expired evidence through both the base table and the invoker-security freshness view. A restricted save function refreshes owned research without exposing expired rows.
- Test both branches using their actual runtime logins: no subject sees no rows, user A cannot read or mutate B's rows, revoked users lose access, and cleanup preserves fresh evidence.

## Deployment freeze

- After the authorized restoration to Git `main` plus RLS on 2026-10-24, all further deployments require explicit operator authorization, including rollbacks and Neon function deployments.
- The Google audit's estimated date, a PR approval, or a merge does not lift the freeze.

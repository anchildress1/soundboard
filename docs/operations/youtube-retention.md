# YouTube genre-search retention

- `job_audience` holds search evidence and its original retrieval time; job JSON holds no research cache.
- All evidence reads use the `job_audience_fresh` view, which excludes evidence at least 30 days old using the database clock. Re-picking refreshes expired evidence; retries and Shorts preserve the original retrieval time.
- Migration `0001` discards legacy research because its retrieval time was never recorded; artist drafts remain available.
- Migration `0002` rejects embedded research at the database write boundary so an older app revision cannot restore it during deployment.
- After expiry, approval accepts the draft's own selected tags and hashtags, not the expired candidate pool.
- Migration `0003` discards incompatible single-list research and adds the freshness view; drafts survive, and expired rows remain inaccessible before daily deletion.
- Each eligible video supplies a separate labeled list of first-seen unique terms. No cross-video merging, counts, ranking, or weighting; approval uses union membership only. Examples preserve YouTube search order, and view counts never enter candidate logic or model prompts.

## Daily deletion on Neon

Run migrations before deploying the cleanup function. Deployment is separate from the app release; the schedule must be enabled on the intended Neon branch.

Neon Functions run only on Node.js 24, while the app runs on 26. Keep `functions/genrecleanup.ts` and everything it imports (`src/lib/server/core/genre-cleanup.ts`, `pg`) to APIs available in Node 24.

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
- Verify an actual invocation in Neon logs and confirm its response reports a deletion count. An unsuccessful run returns HTTP 500 and must be investigated.
- Local tests prove SQL deletion and request handling, not that a remote schedule has been provisioned.

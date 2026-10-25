# Quickstart: Validating resumable upload

## Gate G1 (constitution V): ran 2026-10-22

Ran against the real bucket with throwaway objects under `g1-check/`, deleted afterwards.

- **Setup:**
  - Sessions were created over the JSON API with `Origin: http://localhost:5173` and a declared size.
  - The browsers were Playwright 1.63.0 Chromium, Firefox and WebKit, served on that origin.

| Check                                            | Result                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Cross-origin `PUT` to the session URI            | ✅ All three engines.                                                                                                  |
| `308` returned to script; `Range` readable       | ✅ All three: `308` with no `Range` before any bytes, `308` with `bytes=0-1048575` after 1 MiB, `200` on completion.   |
| `upload.onprogress` during a `PUT`               | ✅ All three.                                                                                                          |
| Declared size enforced                           | ✅ A total above the declared length got `400` "does not match the expected size". No extra server check is needed.    |
| Bytes kept from a single `PUT` that died mid-way | ✅ Aborted after 1.6 s, 40,632,320 bytes were saved (256 KiB-aligned), and the rest finished from that offset (`200`). |
| 8 MiB parts vs one `PUT`, 64 MiB, fast link      | ❌ for parts: 6.2 s vs 1.05 s (5.9×). Decision: one `PUT` per attempt (research R2).                                   |

Follow-ups, ran 2026-10-22 on the same bucket and engines (research R13):

| Check                                                                                     | Result                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ifGenerationMatch: 0` at finalize                                                        | ✅ Another writer landed the object mid-session. The session's final `PUT` got `412` "At least one of the pre-conditions you specified did not hold", and the other writer's 10-byte object was kept. |
| `ifGenerationMatch: 0` at session creation                                                | ❌ not enforced: a new session for an existing object still opened (`200`). So `upload-session` keeps its own "already landed" 409.                                                                   |
| Session made for `http://localhost:5173`, used from `https://soundboard.anchildress1.dev` | ✅ Status query returned `308` in Chromium, Firefox and WebKit, same as a same-origin session. Bucket CORS decides, so the origin isn't stored and status 0 never triggers a renew.                   |

Not run: Gemini checks (spec 002's own gate).

## Automated

```bash
make ai-checks
pnpm test:e2e
```

What the tests cover is in [research R12](research.md#r12--tests-only-what-can-break). GCS behavior isn't re-tested; G1 proved it.

## Live: local dev against the dev bucket

No deploy. `pnpm dev` on `http://localhost:5173` (already in bucket CORS) with the dev `.env`, whose `GCS_BUCKET` is the dev bucket. Desktop Chrome with DevTools, then Firefox and Safari for steps 1 and 3.

- **Test video:** `~/Downloads/*.mp4` is read-only. The largest there is about 211 MB and 3.5 min, so build a ~1.2 GB, 14-minute copy for SC-001 in the scratchpad, never in `~/Downloads`:

  ```bash
  SCRATCH="$(mktemp -d)"
  ffmpeg -stream_loop 3 -i "$HOME/Downloads/main_both wyatt.mp4" \
    -c:v libx264 -preset ultrafast -b:v 11M -maxrate 11M -bufsize 22M -c:a copy \
    "$SCRATCH/sc001-1.2g.mp4"
  ```

  Check it with `ffprobe`: under 15 minutes and under 2 GB, or create refuses it.

- **Drops:** DevTools Network "Offline" toggled by hand, or a headed Playwright script against the dev server calling `context.setOffline(true/false)` on a timer. Throttle to "Fast 4G" so a drop lands mid-`PUT`.

1. Upload the 1.2 GB file and drop the connection 20 times. It finishes with no click, and the page shows "Upload paused: no connection" on each drop. Note the wall time.
2. Upload the 211 MB original with no drops and no throttle, on `main` and on this branch. This branch is no slower, within noise (SC-005).
3. Open other pages in the app mid-upload, then come back. Bytes kept arriving (DevTools shows the one `PUT` still open).
4. Close the tab mid-upload and reopen the job: it shows the saved percentage before any pick. Re-pick the same file: bytes flow again within 5 s. Pick a different file: "New video: starting the upload over." and it starts from 0.
5. Two tabs on one job: the second shows "Uploading in another tab". Close the first: the second shows the file prompt.
6. Discard mid-upload. `gcloud storage ls gs://$GCS_BUCKET/uploads/<jobId>` finds nothing.
7. In Sentry (dev DSN), the breadcrumbs show amounts only. No URL carries `upload_id`.
8. Clean up: delete every `uploads/<jobId>` the run created and discard its jobs.

## Deployed only (after the next deploy, not in this run)

- Start on the custom domain, re-pick on a run.app URL. It continues on the same session. G1's follow-up already showed bucket CORS decides, so this is a smoke check, not a gate.
- `deploy.sh` applied the CORS list without `x-goog-content-length-range`.

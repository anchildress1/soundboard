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

Follow-ups, ran 2026-10-22 on the same bucket and engines (research R13). The two `ifGenerationMatch` rows tested machinery that revision 2 removed; they stay as the record.

| Check                                                                                     | Result                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ifGenerationMatch: 0` at finalize                                                        | ✅ Another writer landed the object mid-session. The session's final `PUT` got `412` "At least one of the pre-conditions you specified did not hold", and the other writer's 10-byte object was kept.                                                |
| `ifGenerationMatch: 0` at session creation                                                | ❌ not enforced: a new session for an existing object still opened (`200`). So `upload-session` keeps its own "already landed" 409.                                                                                                                  |
| Session made for `http://localhost:5173`, used from `https://soundboard.anchildress1.dev` | ✅ Status query returned `308` in Chromium, Firefox and WebKit, same as a same-origin session. Read on 2026-10-25: this is the JSON API's default CORS, not bucket CORS (research R1). The origin isn't stored, and status 0 never triggers a renew. |

Not run: Gemini checks (spec 002's own gate).

## Gate G2 (constitution V): passed 2026-10-25

Ran on the dev bucket (`GCS_BUCKET` in `.env`) with throwaway objects under `g2-check/`, deleted afterwards (a final listing of `g2-check/` was empty).

- **Setup:**
  - Each run created a JSON API session with `Origin: http://localhost:5173` and a declared 48 MiB (50,331,648 bytes) of deterministic bytes.
  - Playwright 1.63.0 desktop Chromium, Firefox and WebKit, on that origin.
  - Two `XMLHttpRequest` `PUT`s of the same bytes from the same offset started together; a status query (`Content-Range: bytes */<size>`) went out 400 ms later, while both were in flight.
  - Two variants per engine: from offset 0, and from 8 MiB after an 8 MiB partial `PUT` saved `bytes=0-8388607`.
  - The whole run went twice.
- **Pass rule:** the object lands once, byte-identical (GCS `md5Hash` vs a local MD5 of the same bytes; one version under the name), and every request ends in a status the uploader recovers from.

| Engine   | Variant          | `PUT` A | `PUT` B | Status query mid-flight  | Query after | Landed                     | Result |
| -------- | ---------------- | ------- | ------- | ------------------------ | ----------- | -------------------------- | ------ |
| Chromium | from 0           | 503     | 200     | `308`, no `Range`        | `200`       | once, 50,331,648 B, MD5 ok | ✅     |
| Chromium | from 8 MiB saved | 200     | 503     | `308`, `bytes=0-8388607` | `200`       | once, 50,331,648 B, MD5 ok | ✅     |
| Firefox  | from 0           | 200     | 503     | `308`, no `Range`        | `200`       | once, 50,331,648 B, MD5 ok | ✅     |
| Firefox  | from 8 MiB saved | 200     | 503     | `308`, `bytes=0-8388607` | `200`       | once, 50,331,648 B, MD5 ok | ✅     |
| WebKit   | from 0           | 503     | 200     | `308`, no `Range`        | `200`       | once, 50,331,648 B, MD5 ok | ✅     |
| WebKit   | from 8 MiB saved | 503     | 200     | `308`, `bytes=0-8388607` | `200`       | once, 50,331,648 B, MD5 ok | ✅     |

- Both runs matched: GCS serves one `PUT` per session at a time and answers the other `503`. The uploader already treats `503` as "storage busy": pause, back off, status query, resume.
- The status query never disturbed the active `PUT`.
- **Decision:** a same-file takeover reuses the session. The fallback (research R13) is not built.

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
4. Close the tab mid-upload and reopen the job: it shows the saved percentage before any pick. Re-pick the same file: bytes flow again within 5 s. Reload and pick a different file: "New video: starting the upload over." and it starts from 0. Close that tab right after the last byte, before the page sees the reply, and reopen: it moves on to analysis with no pick. Then `gcloud storage ls gs://$GCS_BUCKET/uploads/<jobId>/` lists exactly one object, the one `jobs.data->>'object'` names: the sweep removed the old partial's object if it had finished.
5. Two tabs on one job: open the second without picking. It shows "Uploading in another tab". Close the first: the second shows the file prompt.
6. Two browsers (Chrome and Firefox) on one job: pick the same file in the second. The first stops with "The upload moved to another device or window." within about 40 s, and only the second sends. Then pick a different file in the first: the second stops with "A different video replaced this upload."
7. Discard mid-upload with the Discard button on the working screen. `gcloud storage ls gs://$GCS_BUCKET/uploads/<jobId>/` finds nothing. Repeat on a job whose upload finished while its page was closed: discard keeps that one object.
8. In Sentry (dev DSN), the breadcrumbs show amounts only. No URL carries `upload_id`, and no event holds a session URI. In the dev database, `jobs.data->'videoUpload'->>'sessionCipher'` is ciphertext, not a URL.
9. Clean up: delete every `uploads/<jobId>/` prefix the run created and discard its jobs.

### Results: 2026-10-25

Ran on `pnpm dev` against the dev bucket using headless Playwright 1.63, with Chrome (`channel: 'chrome'`), Firefox, and WebKit standing in for Safari. The branch was at `6b71dcf` unless a row says otherwise. The big file is the 1,132,486,295 B, 14-minute copy, the original is 211,318,537 B, and the small file is 31,815,277 B.

How the run differed from the steps above:

- **Drops.** Chromium's emulated offline doesn't stop an XHR that's already sending, so it can't cut a `PUT` mid-body. Drops ran through a local CONNECT proxy instead. Each drop closed every open tunnel and refused new ones, alongside `context.setOffline`.
- **Re-sent bytes.** These were counted at the proxy as bytes sent upstream minus the file size, because Chromium's XHR `loaded` undercounts.
- **Sentry.** Envelopes were captured in the page through `beforeEnvelope` and searched for `upload_id`, `uploadType` and session URIs. Nothing was routed through Playwright, because request routing crashes Chrome on a 1.13 GB body.
- **No model calls.** A fetch wrapper in the page refused every step after the landing step. In the step 6 runs, the second browser let one PREP step (ffmpeg only) through. No ANALYZE step ran: `chunkIndex` stayed 0, with no wait or error.
- **Database.** Mid-run, the dev database moved to spec 004's schema and RLS. After that, creating a job on this branch returns 500, so steps 5 to 7 reused jobs that earlier runs had left in AWAITING_UPLOAD.
- **Step 2 baseline.** `main` wasn't run, because its signed-URL `PUT` needs bucket CORS for its own origin. The baseline is `gcloud storage cp` of the same file from the same machine.

| Step                     | Browser                 | File     | Drops | Wall time                   | Result                                                                                                                                                            |
| ------------------------ | ----------------------- | -------- | ----- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (SC-001)               | Chrome                  | big      | 20    | 146.5 s                     | Pass on `096e54f`: "Upload paused: no connection" on every drop, about 1 s back to sending, 0.59% re-sent, one object                                             |
| 1                        | Firefox                 | big      | 20    | 143.4 s                     | Pass on `096e54f`: 0.85% re-sent, one object                                                                                                                      |
| 1                        | WebKit                  | big      | 20    | 143.5 s                     | Fail on `096e54f`: never left "Uploading 100%". Pass on `6b71dcf`: 0.72% re-sent, one object                                                                      |
| 2 (SC-005)               | Chrome                  | original | 0     | 20.5 s                      | Pass against `gcloud storage cp` (10.5 s and 41.8 s), not against `main`                                                                                          |
| 3 (SC-006)               | all three               | big      | 0     | 8 s away                    | Pass: the one `PUT` stayed open the whole time                                                                                                                    |
| 4 (SC-003), same file    | Chrome, Firefox, WebKit | big      | 0     | 1.54, 1.57, 1.92 s to bytes | Pass: the page showed 15%, 16% and 15% before the pick                                                                                                            |
| 4, different file        | all three               | small    | 0     | —                           | Pass: "New video: starting the upload over." and the `PUT` started at byte 0                                                                                      |
| 4, close after last byte | Chrome                  | small    | 0     | —                           | Pass: reopening went straight to PREP with no pick                                                                                                                |
| 4, close after last byte | Firefox, WebKit         | small    | 0     | —                           | Not reproduced: the last bytes hadn't reached storage when the tab closed, so reopening asked for a pick at 98% and 99%. The re-pick landed                       |
| 4 (SC-004), objects      | all three               | —        | —     | —                           | Pass: one object under the prefix, the one `jobs.data->>'object'` names                                                                                           |
| 5, two tabs              | all three               | big      | 0     | —                           | Pass: "Uploading in another tab" with no picker and no `PUT`. Closing the first tab brought up the prompt, and the re-pick resumed                                |
| 6, same file             | Chrome, then Firefox    | big      | 0     | 29 s to notice              | Pass: Chrome stopped with "The upload moved to another device or window." and sent nothing more, while Firefox kept sending                                       |
| 6, different file        | Chrome over Firefox     | small    | 0     | —                           | Not seen: the small file landed before Firefox's next check, so Firefox moved on to analysis without showing "A different video replaced this upload." One object |
| 7, discard mid-upload    | all three               | big      | 0     | —                           | Pass: DISCARDED, no object, `sessionCipher` cleared                                                                                                               |
| 7, discard after landing | Chrome                  | small    | 0     | —                           | Pass: the one object stayed                                                                                                                                       |
| 8                        | all three               | —        | —     | —                           | Pass: the only GCS URL anywhere was `…/o?[redacted]`, breadcrumbs carried `reason`, `saved` and `total` only, and `sessionCipher` was ciphertext                  |
| 9                        | —                       | —        | —     | —                           | Done: 17 jobs discarded and the bucket left empty                                                                                                                 |

The run found three bugs, each fixed on this branch with a test:

- `7e15e24`: if the step after the last byte got no reply, the page stopped asking and stayed at "Uploading 100%".
- `096e54f`: the backoff from offline failures carried over after the link came back, so a resume could wait out a long delay.
- `6b71dcf`: in Safari, Sentry's fetch wrapper gives fetch's TypeError a stack. p-retry then treated it as a bug and gave up on the first app request that got no reply, so the upload never landed.

After landing, the page showed a lower saved percentage than storage later reported, for example 6% shown and 16% resumed. GCS records aborted bytes a little after the abort, and the resume always used storage's offset.

## Deployed only (after the next deploy, not in this run)

- Start on the custom domain, re-pick on a run.app URL. It continues on the same session: session reuse across app origins. JSON API endpoints answer CORS for any origin, and the URI's secrecy is the authorization (research R1), so this is a smoke check, not a gate.
- `deploy.sh` applied the CORS list with `GET` only and without `x-goog-content-length-range`; Monitor playback and seeking still work.

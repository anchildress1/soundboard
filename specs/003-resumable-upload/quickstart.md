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

## Deployed only (after the next deploy, not in this run)

- Start on the custom domain, re-pick on a run.app URL. It continues on the same session: session reuse across app origins. JSON API endpoints answer CORS for any origin, and the URI's secrecy is the authorization (research R1), so this is a smoke check, not a gate.
- `deploy.sh` applied the CORS list with `GET` only and without `x-goog-content-length-range`; Monitor playback and seeking still work.

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

## Manual: deployed

Desktop browser with DevTools throttling ("Slow 4G").

1. Upload a 1.2 GB video and toggle offline 20 times. It finishes with no click.
2. Open other pages in the app mid-upload. It keeps going.
3. Close the tab mid-upload, reopen the job: it shows the saved percentage before any pick. Re-pick: it continues within 5 s. Pick a different file: it starts over.
4. Start on the custom domain, re-pick on the run.app URL. It continues on the same session.
5. In Sentry, the breadcrumbs show amounts only. No URL carries `upload_id`.

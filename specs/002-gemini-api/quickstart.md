# Quickstart: Validating the Gemini API swap

## Gate G1 (constitution V): ran 2026-10-22

- **Setup:** real paid project, `gemini-3.8-flash` and `gemini-4-argon`.
- **Test video:** synthetic, 15 minutes, 1.97 GB, with an on-screen seconds counter and a spoken "Window N" per window.
- **Spend:** under about $0.40.
- **Cleanup:** every object under `g1-check/` was deleted.
- **Details:** [research R12](research.md#r12--manual-gate-g1-constitution-v-ran-2026-10-22).

| Check                                             | Result                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register the 2 GB object ×31                      | ✅ 0.3–0.5 s each; no `state` or expiry returned (now moot)                                                                                       |
| Auth                                              | Key + OAuth → 401; OAuth only → 403. The authorization key is the only credential.                                                                |
| `store: false` and clip offsets on the wire       | ✅                                                                                                                                                |
| Clip limits frames **and** audio                  | ✅ only that window's speech and counter                                                                                                          |
| Tokens scale with clip length                     | ✅ ~1.4k for 15 s, ~2.7k for 29.5 s, ~5.5k for 60 s                                                                                               |
| Analyst, registered 2 GB file, last window, ≤30 s | ❌ 504 at 120 s ×2, then 255 s                                                                                                                    |
| Fallbacks, same clip                              | 58 MB proxy 34 s; 0.8 MB clip registered 8 s; **60 s clip inline 6.4 s**, adopted                                                                 |
| Argon smart pick p95 (`medium`, 5 runs)           | ✅ 32.8 s                                                                                                                                         |
| Argon hook pick p95 (`low`, 5 runs)               | ✅ 34.6 s                                                                                                                                         |
| Per-day quota 429 body                            | Not captured; shape from docs, verify on first occurrence                                                                                         |
| Follow-up: pick p95 at full #20 prompt (FR-021)   | ✅ 2026-10-23: 5/5 runs at 12.7k input tokens (10 lists × 40 tags + 30 hashtags, 5 examples, 3 recent uploads, 15 chunks), p95 10.5 s, cost $0.15 |

Setup the gate needed that the app doesn't:

- The Gemini service agent was created and given bucket read access.
- The key's bound service account was given bucket read access.

Neither is needed now that clips go inline. Both bindings were removed on 2026-10-22; the service agent identity remains and has no grants.

## Automated

```bash
make ai-checks   # format, lint, typecheck, unit tests (coverage floors), build
make e2e        # desktop Chrome + Pixel 7; fake provider HTTP and window media, no ffmpeg
```

Expected:

- **Unit tests:**
  - The model client sends `store: false`, `telemetry: { isEnabled: false }`, the per-agent model, thinking level and token cap, and the schema as `response_format` (see [contracts/model-client.md](contracts/model-client.md)).
  - `mediaResolution: 'low'` goes out on `chunk-analyst` only.
  - A re-ask sends the earlier answer as an `assistant` turn.
  - A 429 with a `PerDay` `QuotaFailure` (in `data.error.details`, or `responseBody` as the fallback) → `ModelQuotaSpent`; any other 429 and 503 → `ModelBusy`; 400, 403 and 500 → `Error`.
  - A re-ask with less time left than the agent's minimum call budget isn't started; the raw text is kept.
  - Analyze calls `cutWindowClip` before `measureWindow`, and the clip's temp file is deleted even when the call throws.
  - Brand propose returns `model quota spent` on a per-day 429, and the page stops polling on it.
  - The client is built with `createGoogle`, and the system prompt goes out as `instructions`.
  - `NoObjectGeneratedError`, `NoOutputGeneratedError`, `incomplete` status and empty text → one re-ask, then raw.
  - A spent deadline throws before the call.
  - The analyst sends one inline `video/mp4` part (the window clip), and no image or audio parts.
  - Windows are 60 s; a 15-minute video gives 15 chunks.
  - An incompatible analyze step clears the actual `jobs.chunks` array and resets index/error/failure state in the same claim-guarded transaction as `PREP`; no ffmpeg or provider call. A stolen claim or concurrent discard changes neither chunks nor state; a transaction failure rolls both back. The next prep computes the new count.
  - Smart pick and brand still send thumbnails as `image` parts.
  - Pipeline: `ModelBusy` mid-analyze or mid-pick returns `model busy`, keeps finished chunks, and leaves `consecutiveFailures` unchanged. `ModelQuotaSpent` sets `limitUntil`, and later steps wait without calling the provider. Two real failures still set `FAILED`.
  - Tracing: provider `gcp.gemini`, per-call model on both `chat` and `invoke_agent` spans, video redacted to `{type, mime, bytes, clip}` with no data.
  - View: labels explicitly say `Configured analyst` or `Configured picker`, including failed-state role selection, and total time is separate. Changing config while viewing an old Gemma result never claims Gemini generated it.
  - Text diagnostics: every agent's prompt, reply, reasoning, assistant re-ask and failed parse text is present on the manual spans; there is no per-agent `recordText` switch. Media bytes, credentials and signed-URL queries remain absent from spans and captured exceptions.
  - Typed error flow: busy/quota exceptions retain their class and reset time through trace capture; malformed SDK outputs still enter the one-re-ask path. No raw SDK request body or media-bearing cause is captured.
  - Parse exhaustion: analyst persists stripped raw text; pick/hook use the two-strike failure path, brand returns its retryable error, and their raw text remains in traces rather than new database fields.
  - The privacy page names both processors and discloses implicit caching, the 55-day abuse log/human review/deletion limits and actual Sentry retention (FR-018).
  - A clip at the 8,000,000-byte limit is accepted; one byte over is rejected before the file is read or the provider called.
  - One simulated clock/deadline covers cut, measurement and inference: timeout/cancellation terminates ffmpeg, removes its file and saves no partial chunk; no call starts without its minimum budget and no helper renews the 110 s deadline.
  - Window counts skip a sub-second tail: 60 s → 1, 60.5 s → 1, 61.5 s → 2, 900 s → 15. New Shorts and existing `HOOK` retries/re-picks check parent compatibility; existing absolute cuts can render/re-cut/publish without reinterpreting old indices.
- **E2E:** analyze reaches the model call through the faked window module and shows `model busy` from the HTTP preload; pick and Short steps show the same. The real SDK/client runs; no live Gemini, no ffmpeg. No `waking model` text remains.
- **Removal sweep:** `grep -rn "llama\|gemma\|MODEL_URL\|waking model\|another run\|vertex" src tests deploy.sh service.yaml .env.example` returns nothing. `model/` and `build-model.sh` are gone.

## Manual: deployment gate (FR-023)

- **Blocked until approval:** record the YouTube approval reference, date and scope covering disclosed Gemini processing/storage and Sentry text retention; submission or owner risk acceptance is not approval.
- Record the actual Sentry subscription, billing model and retention for errors, full spans and sampled spans; shorter retention is optional, not a substitute for approval.
- G2 passed on 2026-10-24 with configuration A (research R14). The Gemma baseline is captured, so the teardown no longer waits on it.
- No standalone deploy: this feature ships in the next combined release, after approval. No hosted validation deployment or traffic change before then. Local mock tests and approved local gates can proceed.
- The GPU teardown doesn't wait on approval: the GPU version is never redeployed.

## Manual: deployed, at the combined release after approval

1. Put `GEMINI_API_KEY` in `.env`, then `./deploy.sh`. Expected: `soundboard-gemini-api-key` is in Secret Manager, no Vertex step runs.
2. Upload a 3-minute video and a 15-minute video. Both reach review with chunk N/M shown and every step under about 2 minutes, including seeking/cutting/measurement/inference on Cloud Run (SC-002, SC-003). Include first and last windows of a 2 GB, 15-minute source; inspect portrait/high-frame-rate/noisy inputs, verify complete clip duration/audio and size guards, and force timeout cleanup. Check pick and hook latency against G1 budgets.
3. Check the pick: every hashtag and tag is from the candidates, and there are no loudness numbers in the text (SC-004).
4. Make a Short and propose a brand guide. Both complete.
   - Open `/privacy`: it names the Gemini API (SC-008).
5. In Sentry, all agents show text diagnostics including a forced failed parse, but no media bytes, credentials or signed-URL queries (SC-007). The job remains one trace with actual per-call models, and no duplicate AI SDK span. Confirm the retention and privacy disclosure match the approved deployment evidence.
6. One-time teardown of the GPU deployment (FR-014), any time; it doesn't wait on steps 1–5:
   ```bash
   gcloud ai endpoints list --region us-central1 --project "$GCP_PROJECT_ID"   # find soundboard-model
   gcloud ai endpoints undeploy-model <endpoint-id> --deployed-model-id <id> --region us-central1 --project "$GCP_PROJECT_ID"
   gcloud ai endpoints delete <endpoint-id> --region us-central1 --project "$GCP_PROJECT_ID"
   gcloud ai models list --region us-central1 --project "$GCP_PROJECT_ID"      # each soundboard-model-*
   gcloud ai models delete <model-id> --region us-central1 --project "$GCP_PROJECT_ID"
   gcloud artifacts docker images delete us-central1-docker.pkg.dev/$GCP_PROJECT_ID/soundboard/model --delete-tags
   gcloud iam roles delete <model invoker role id> --project "$GCP_PROJECT_ID"
   ```
   Expected: both list commands show no Soundboard entries. GPU spend is $0 the next full week (SC-001).

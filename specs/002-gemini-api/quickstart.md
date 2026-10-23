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
pnpm test:e2e    # desktop Chrome + Pixel 7, E2E_FAKES=1
```

Expected:

- **Unit tests:**
  - The model client sends `store: false`, `telemetry: { isEnabled: false }`, the per-agent model, thinking level and token cap, and the schema as `response_format` (see [contracts/model-client.md](contracts/model-client.md)).
  - `mediaResolution: 'low'` goes out on `chunk-analyst` only.
  - A re-ask sends the earlier answer as an `assistant` turn.
  - A 429 with a `PerDay` `QuotaFailure` (in `data.error.details`, or `responseBody` as the fallback) → `ModelQuotaSpent`; any other 429 and 503 → `ModelBusy`; 400, 403 and 500 → `Error`.
  - A re-ask with less time left than the agent's minimum call budget isn't started; the raw text is kept.
  - Analyze calls `cutWindowClip` before `measureWindow`, and the clip's temp file is deleted even when the call throws.
  - Brand propose returns `model quota spent`, and the page stops polling on it.
  - The client is built with `createGoogle`, and the system prompt goes out as `instructions`.
  - `NoObjectGeneratedError`, `NoOutputGeneratedError`, `incomplete` status and empty text → one re-ask, then raw.
  - A spent deadline throws before the call.
  - The analyst sends one inline `video/mp4` part (the window clip), and no image or audio parts.
  - Windows are 60 s; a 15-minute video gives 15 chunks.
  - Smart pick and brand still send thumbnails as `image` parts.
  - Pipeline: `ModelBusy` mid-analyze or mid-pick returns `model busy`, keeps finished chunks, and leaves `consecutiveFailures` unchanged. `ModelQuotaSpent` sets `limitUntil`, and later steps wait without calling the provider. Two real failures still set `FAILED`.
  - Tracing: provider `gcp.gemini`, per-call model on both `chat` and `invoke_agent` spans, video redacted to `{type, mime, bytes, clip}` with no data.
  - View: `model` is the analyst model during `PREP`/`ANALYZE` and the pick model after.
  - YouTube data stays out of Sentry (FR-017):
    - Pick, hook and brand spans, the `hashtag_search` tool result and captured errors contain no YouTube-sourced titles, descriptions, tags or thumbnails, only `{source, chars}` and `{mime, bytes, source}` placeholders.
    - The song title and notes are still recorded.
  - The privacy page names the Gemini API as a processor of video clips and YouTube metadata (FR-018).
- **E2E:** analyze and Short steps show `model busy` from the faked client, after the clip cut runs on the generated fixture video. No `waking model` text remains.
- **Removal sweep:** `grep -rn "llama\|gemma\|MODEL_URL\|waking model\|another run\|vertex" src tests deploy.sh service.yaml .env.example` returns nothing. `model/` and `build-model.sh` are gone.

## Manual: deployed

1. Put `GEMINI_API_KEY` in `.env`, then `./deploy.sh`. Expected: `soundboard-gemini-api-key` is in Secret Manager, no Vertex step runs.
2. Upload a 3-minute video and a 15-minute video. Both reach review with chunk N/M shown and every step under about 2 minutes, including the clip cut on Cloud Run (SC-002, SC-003). Check real pick and hook latency against the G1 budgets.
3. Check the pick: every hashtag and tag is from the candidates, and there are no loudness numbers in the text (SC-004).
4. Make a Short and propose a brand guide. Both complete.
   - Open `/privacy`: it names the Gemini API (SC-008).
5. In Sentry, a pick's spans show placeholders where the candidate lists, top videos and recent uploads were, and no YouTube text (SC-007). The job is one trace, with `chat gemini-3.8-flash` and `chat gemini-4-argon` spans and no media or signed-URL queries (SC-007). There's no second `gen_ai.generate_content` span from the AI SDK.
6. One-time teardown of the GPU deployment (FR-014):
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

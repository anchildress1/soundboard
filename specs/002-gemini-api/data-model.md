# Data Model: Gemini API in place of self-hosted Gemma

No database schema change and no migration. Jobs, chunks, picks and Shorts keep their shape.

## Changed types

### `Wait` (`src/lib/types.ts`)

| Removed                  | Added               |
| ------------------------ | ------------------- |
| `waking model`           | `model busy`        |
| `waiting on another run` | `model quota spent` |

- `model busy`: the provider answered 429 or 503.
- `model quota spent`: a per-day quota is spent. The step sets the job's existing `limitUntil` to the reset (next midnight Pacific), and later steps wait without calling the provider until then, as with YouTube's `DAILY_LIMIT`.
- Apply the job cooldown before analyze, pick and hook side effects, and clear an expired model limit when work resumes so it cannot be mistaken for a later YouTube wait.
- Neither increments `consecutiveFailures`.

### Model request (`src/lib/server/core/tracing.ts`)

Replaces the OpenAI-style `ChatMessage[]`.

```ts
type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mime_type: string } // thumbnails, base64
  | { type: 'video'; data: Uint8Array; mime_type: string; start: number; end: number }; // inline window clip (360p MP4); start/end in source seconds

type Turn = { role: 'user' | 'assistant'; parts: Part[] };

type ModelRequest = { system: string; turns: Turn[] };
```

- `turns` holds the re-ask history: pick and hook resend the earlier answer as an `assistant` turn plus a `user` follow-up. The first call is one `user` turn.
- Redacted for Sentry, turn by turn:
  - `image` → `{type, mime, bytes}`; `video` → `{type, mime, bytes, clip: '<start>s–<end>s'}`. Never `data`.
  - System/user/assistant text, replies and reasoning are retained for every agent, including YouTube-derived text (FR-017). No per-agent text setting.

### `JobView` (`src/lib/types.ts`)

- Adds `model: string`, explicitly the current configuration: analyst during `PREP`/`ANALYZE`, picker otherwise and for Shorts. For `FAILED`, use `failedState` to choose the configured role.
- Render `Configured analyst: <model>` or `Configured picker: <model>` separately from `Total model time: <seconds>s`. Existing results have no persisted provenance; never imply this label identifies their generating model. Actual per-call model names remain in traces.

## Configuration

| Name                   | Where                                                      | Default            |
| ---------------------- | ---------------------------------------------------------- | ------------------ |
| `GEMINI_API_KEY`       | Secret Manager `soundboard-gemini-api-key`; `.env` locally | required           |
| `GEMINI_ANALYST_MODEL` | `service.yaml` env                                         | `gemini-3.8-flash` |
| `GEMINI_PICK_MODEL`    | `service.yaml` env                                         | `gemini-4-argon`   |
| `MODEL_URL`            | removed                                                    | —                  |

## Window

- `WINDOW_SEC = 60` (was 29.5, Gemma's audio cap). Chunk count uses today's `chunkCount` helper with the new window: `max(1, ceil((duration − 1) / 60))`, so a trailing sliver under 1 s isn't sent to the model. 15 for a 15-minute video.
- Existing jobs aren't migrated (pre-beta). An incompatible claimed `ANALYZE` step returns `PREP`, `chunkIndex: 0`, cleared error/failure fields and a chunk-clear operation. `releaseJob` applies the state patch and clears the actual `jobs.chunks` column in one transaction only when the claim token and claimed state still match; an ordinary `JobPatch` does not clear that column. No media or model call runs. The subsequent prep recomputes `chunkCount`.
- New Shorts and every `HOOK` retry/re-pick compare the parent video's stored count with `chunkCount(sourceDurationSec)`. A mismatch takes the "new upload required" path before the hook pick; do not compare the Short job's default chunk count. A completed absolute hook may still render, be re-cut, reviewed and published without reinterpreting its old window index.
- `FRAMES_PER_WINDOW` and `extractWindow` are removed. `cutWindowClip` writes the window's 360p clip to a temp file, and `measureWindow` keeps the window measurements.

## Unchanged invariants

- Chunk analysis schema (`CHUNK_SCHEMA`), pick schema, hook schema and brand schema are the same JSON Schemas. They are passed through `Output.object` to the provider's JSON response format.
- `modelMs` on chunks, picks and Shorts keeps meaning wall-clock model time.

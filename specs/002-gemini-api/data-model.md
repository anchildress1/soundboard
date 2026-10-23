# Data Model: Gemini API in place of self-hosted Gemma

No schema change and no migration. Jobs, chunks, picks and Shorts keep their shape.

## Changed types

### `Wait` (`src/lib/types.ts`)

| Removed                  | Added               |
| ------------------------ | ------------------- |
| `waking model`           | `model busy`        |
| `waiting on another run` | `model quota spent` |

- `model busy`: the provider answered 429 or 503.
- `model quota spent`: a per-day quota is spent. The step sets the job's existing `limitUntil` to the reset (next midnight Pacific), and later steps wait without calling the provider until then, as with YouTube's `DAILY_LIMIT`.
- Neither increments `consecutiveFailures`.

### Model request (`src/lib/server/core/tracing.ts`)

Replaces the OpenAI-style `ChatMessage[]`.

```ts
type Part =
  | { type: 'text'; text: string; source?: 'youtube' } // source marks YouTube API data (FR-017)
  | { type: 'image'; data: string; mime_type: string; source?: 'youtube' } // thumbnails, base64
  | { type: 'video'; data: Uint8Array; mime_type: string; start: number; end: number }; // inline window clip (360p MP4); start/end in source seconds

type Turn = { role: 'user' | 'assistant'; parts: Part[] };

type ModelRequest = { system: string; turns: Turn[] };
```

- `turns` holds the re-ask history: pick and hook resend the earlier answer as an `assistant` turn plus a `user` follow-up. The first call is one `user` turn.
- Redacted for Sentry, turn by turn:
  - `text` with `source` → `{type: 'text', source, chars}`; other text is recorded as is.
  - `image` → `{type, mime, bytes}`, plus `source` when it's YouTube's.
  - `video` → `{type, mime, bytes, clip: '<start>s–<end>s'}`.
  - Never `data`, and never the text of a YouTube-sourced part.

### `JobView` (`src/lib/types.ts`)

- Adds `model: string`. The server sets it: the analyst model while the job is in `PREP`/`ANALYZE`, the pick model otherwise, and the pick model for Shorts.
- The job page and Short tab render `${view.model} · ${seconds}s` instead of the hard-coded `gemma-4-12b-it`.

## Configuration

| Name                   | Where                                                      | Default            |
| ---------------------- | ---------------------------------------------------------- | ------------------ |
| `GEMINI_API_KEY`       | Secret Manager `soundboard-gemini-api-key`; `.env` locally | required           |
| `GEMINI_ANALYST_MODEL` | `service.yaml` env                                         | `gemini-3.8-flash` |
| `GEMINI_PICK_MODEL`    | `service.yaml` env                                         | `gemini-4-argon`   |
| `MODEL_URL`            | removed                                                    | —                  |

## Window

- `WINDOW_SEC = 60` (was 29.5, Gemma's audio cap). Chunk count = `ceil(duration / 60)`: 15 for a 15-minute video.
- Existing jobs aren't migrated (pre-beta). A job mid-analysis at deploy restarts from prep, which recomputes `chunkCount`.
- `FRAMES_PER_WINDOW` and `extractWindow` are removed. `cutWindowClip` writes the window's 360p clip to a temp file, and `measureWindow` keeps the window measurements.

## Unchanged invariants

- Chunk analysis schema (`CHUNK_SCHEMA`), pick schema, hook schema and brand schema are the same JSON Schemas. They are passed as `response_format.schema`.
- `modelMs` on chunks, picks and Shorts keeps meaning wall-clock model time.

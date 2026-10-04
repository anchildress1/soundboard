Read `docs/prd.md` before changing behavior. It is the source of truth; when code and PRD disagree, stop and ask.

## Hard rules

- Write the artist as "Nathan" or "Flies Like Robots". Never write his surname in code, fixtures, seeds, prompt text, commits, or docs.
- Do not filter or redact his surname from runtime data. Credits in his channel's descriptions pass through to the model, and generated descriptions may repeat them in every run, samples included.
- No voice, persona, or chatbot copy anywhere. UI text is plain labels.
- Audio-engineering numbers (LUFS, peak, clipping, silence) come from ffmpeg only. Strip numerics the model emits.
- Hashtags come only from the job's deterministic candidate list (PRD R4). Reject any hashtag not in it.
- A publish is `VERIFIED` only after `videos.list` returns it. The insert response sets `CLAIMED_COMPLETE`.
- Only allowlisted sessions read or write `artists/*` or Nathan's jobs and tokens. Visitor feedback stays on the job.
- Never record audio or image bytes in Sentry. Use `{type, mime, bytes}` placeholders.
- Never stream media through app memory: ffmpeg and the YouTube upload read from GCS by signed URL.

## Architecture constraints

- One Cloud Run service, max 1 instance, one L4. The app container talks to the `llama-server` sidecar on `127.0.0.1:8081`. Do not add services, queues, Cloud Functions, Eventarc, or background workers.
- The pipeline is page-driven: one step per `POST /api/jobs/{id}/step`, each under ~2 minutes. Model loading or busy returns a wait reason immediately; never block a step on it.
- Each step claims the job in a Firestore transaction with a 3-minute expiry.
- Gemma calls: temperature 0.2, `max_tokens` ≥ 2048, JSON schema, parse `content` (not `reasoning_content`). Audio windows are 29.5s.

## Stack

- SvelteKit 2 + Svelte 5 runes, TypeScript strict, Node 24 via Volta, pnpm.
- Do not upgrade to SvelteKit 3, TypeScript 7, or adapter-node 6 without asking: tooling peers (svelte-check, typescript-eslint) do not support them yet.

## Tests

- Unit tests live in `tests/unit/` mirroring `src/`; E2E in `tests/e2e/`. Import app code through `$lib` / `$routes`, never relative paths into `src/`.
- Coverage floors: 85% lines/functions/statements, 80% branches. Never lower them.
- Every new module ships positive, negative, and edge-case tests. Mock at process boundaries (GCS, Firestore, YouTube, `llama-server`), never internal modules.
- E2E runs desktop Chrome and a Pixel 7 profile; the mobile path is the judged path.

## Workflow

- `make ai-checks` before declaring work done.
- Conventional Commits, GPG-signed, with an AI attribution footer and `Signed-off-by` (commitlint enforces both).
- Never push or commit on `main` without being asked.
- `actions/*` use tagged majors; every other action is pinned to a commit SHA with a version comment.

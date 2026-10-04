# Agent instructions

Audience: AI coding agents. Directives only.

## Source of truth

- Read `docs/prd.md` before changing behavior.
- Code and PRD disagree → stop, ask.

## Content

- Artist name: "Nathan" or "Flies Like Robots". NEVER write his surname in code, fixtures, seeds, prompts, commits, or docs.
- NEVER filter or redact his surname from runtime data (channel credits, model output).
- UI text: plain labels. NEVER persona or chatbot copy.
- Description voice: `ARTIST_VOICE` in `src/lib/server/smart-pick.ts`. Change only on new evidence of how Nathan writes.
- Audio numbers (LUFS, peak, clipping, silence): ffmpeg only. Strip model-emitted numerics (`src/lib/server/numerics.ts`).
- Hashtags and tags: only from the job's candidate lists (PRD R4). Reject anything else.

## Data and access

- `VERIFIED` only after `videos.list` returns the upload. Insert response → `CLAIMED_COMPLETE`.
- Only allowlisted sessions write `artists/*` or reach Nathan's jobs and tokens.
- Demo jobs read Nathan's memory, NEVER write it. Visitor and demo feedback stays on the job.
- Short approvals write EDITED feedback only, never ACCEPTED.
- A visitor's new Short takes one visitor run (`takeVisitorRun`) in the create transaction.

## Media

- ffmpeg and the YouTube upload read sources from GCS by signed URL.
- NEVER buffer whole media in app memory. Stream in chunks or keep it on disk.
- Short renders: temp file in `os.tmpdir()` → `uploadFile` → delete in `finally` → ffprobe read-back from GCS.
- Sentry: NEVER record audio or image bytes. Use `{type, mime, bytes}` placeholders.

## Architecture

- One Cloud Run service, max 1 instance, one L4. App → `llama-server` sidecar at `127.0.0.1:8081`.
- NEVER add services, queues, Cloud Functions, Eventarc, or background workers.
- Pipeline is page-driven: one step per `POST /api/jobs/{id}/step`, each under ~2 minutes.
- Model loading or busy → return a wait reason immediately. NEVER block a step on it.
- Each step claims the job in a Firestore transaction, 3-minute expiry.
- Gemma calls: temperature 0.2, `max_tokens` ≥ 2048, JSON schema, parse `content` (not `reasoning_content`). Audio windows: 29.5 s.

## Stack

- SvelteKit 2, Svelte 5 runes, TypeScript strict, Node 24 (`.nvmrc`), pnpm.
- Ask before upgrading to SvelteKit 3, TypeScript 7, or adapter-node 6.

## Tests

- Unit: `tests/unit/`, mirroring `src/`. E2E: `tests/e2e/`.
- Import app code via `$lib` / `$routes`. NEVER relative paths into `src/`.
- Coverage floors: 85% lines/functions/statements, 80% branches. NEVER lower.
- Every new module: positive, negative, error, and edge-case tests.
- Mock at process boundaries only (GCS, Firestore, Secret Manager, YouTube, `llama-server`, ffmpeg). NEVER mock internal modules.
- `@sentry/sveltekit` is mocked globally (`tests/mocks/sentry.ts`). Assert through that mock. NEVER load the real SDK in tests.
- E2E projects: desktop Chrome and Pixel 7. Pixel 7 is the judged path.
- E2E builds alias Firestore, Storage, and Secret Manager to `tests/e2e/fakes/` (`E2E_FAKES=1`, set by `playwright.config.ts`). Seed jobs in `tests/e2e/fakes/fixtures.ts`; give each test its own job IDs, per Playwright project when the test writes.
- E2E has no `llama-server`: model steps end at the "waking model" wait.

## Workflow

- Run `make ai-checks` before declaring work done.
- Commits: Conventional Commits, signed, one AI attribution footer, `Signed-off-by` (commitlint enforces).
- NEVER commit or push to `main` unless asked.
- GitHub Actions: `actions/*` on tagged majors; all others pinned to a commit SHA with a version comment.

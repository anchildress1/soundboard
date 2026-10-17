# Soundboard Constitution

## Core Principles

### I. Owned Data

- Every user record, job, Short, connection and media URL MUST belong to exactly one user.
  Requests for another user's data MUST return 404 and change nothing.
- An artist profile (memory, identity, brand guide) MUST be read and written only by the user
  linked to it. Unlinked users get no artist data.
- Caches, credentials and quota state MUST be keyed so they never cross users or channels.
- Platform credentials MUST be encrypted at rest and MUST NOT reach logs, traces or responses.

Rationale: the app is multi-user and becoming multi-artist; one leak breaks the product's trust.

### II. Truthful Output

- A publish is `VERIFIED` only after the platform's own read-back returns it.
- Audio numbers MUST come from ffmpeg. Model-emitted numerics MUST be stripped.
- Hashtags and tags MUST come from the job's candidate lists. Anything else is rejected.
- UI text is plain labels. No persona or chatbot copy.
- Description voice MUST be grounded in the artist's own writing, never invented.
- Nathan's surname MUST NOT be written in code, fixtures, prompts, commits or docs, and MUST NOT
  be filtered from runtime data.

### III. One Service, Page-Driven

- One Cloud Run service and one model endpoint. No added services, queues, functions or
  background workers.
- The pipeline advances one step per page request, each under about 2 minutes, claimed in a
  Firestore transaction.
- A cold, busy or unauthorized dependency MUST return a wait reason immediately. A wait never
  fails a job.
- Nothing runs unattended; the user's open page drives every step.

Rationale: one person watches each run; scale comes from raising instance limits, not new parts.

### IV. Domain-Grouped, Platform-Isolated Code

- Server code MUST live in domain folders under `src/lib/server/<domain>/` (for example `auth`,
  `jobs`, `pipeline`, `ai`, `media`). Tests mirror the same paths.
- Each external platform MUST live in its own folder, `src/lib/server/platforms/<name>/`.
  Platform API calls, scopes and error mapping MUST NOT appear outside it.
- Core domains reach a platform only through that folder's `index.ts`.
- A shared platform interface is extracted when the second platform lands, not before.
- Artist-specific values (name, voice, channel IDs) MUST NOT be constants in core code. They
  belong to the artist profile.

Rationale: the repo is growing to many artists and platforms. Placement rules keep each
addition local instead of spreading through every file.

### V. Tested at the Boundaries

- Coverage floors: 85% lines, functions and statements; 80% branches. Never lowered.
- Every new module gets positive, negative, error and edge-case tests.
- Mock only at process boundaries (Firestore, GCS, Secret Manager, KMS, platform HTTP,
  `llama-server`, ffmpeg). Never mock internal modules.
- E2E runs on desktop Chrome and Pixel 7 against the in-repo fakes.
- Provider behavior that Google does not document MUST be proven by a recorded manual gate
  before dependent code is built. Passing mocked tests does not close that gate.

### VI. Simplicity

- KISS and YAGNI outrank other design preferences. Diffs stay minimal and intentional.
- No backward-compatibility paths unless a spec asks for them. Removed behavior leaves no dead
  code.
- Ask before upgrading to SvelteKit 3, TypeScript 7 or adapter-node 6.

## Media, Privacy and Secrets

- Media is never buffered whole in app memory. Stream in chunks or use a temp file deleted in
  `finally`. ffmpeg and uploads read sources from GCS by signed URL.
- Signed URLs are issued only after an ownership check.
- Sentry never records audio, image bytes, tokens or ciphertext.
- Secrets live only in Secret Manager or a local `.env`. Never in the repo.

## Development Workflow

- Features go through Spec Kit: specify → clarify → plan → tasks → implement. Each plan's
  Constitution Check gates against this file; violations need a Complexity Tracking entry.
- Behavior changes follow `docs/prd.md`. Code and PRD disagreeing is a stop.
- `make ai-checks` passes before work is done. Warnings are errors.
- Conventional Commits, signed, with an AI attribution footer and `Signed-off-by`. Branch and
  PR; never commit to `main`.
- Repo config (`package.json`, `deploy.sh`, tool configs) changes only with explicit approval.

## Governance

- This constitution overrides other practices. `AGENTS.md` holds the operational detail for
  agents and MUST NOT contradict it.
- Amendments go through `/speckit-constitution` in a PR, with a version bump:
  MAJOR for removed or redefined principles, MINOR for added or expanded ones, PATCH for wording.
- Every plan and PR review checks compliance. A known violation is recorded with its fix target.

**Version**: 1.0.0 | **Ratified**: 2026-10-16 | **Last Amended**: 2026-10-16

# Soundboard Constitution

## Core Principles

### I. Owned Data

- Every user record, job, Short, connection and media URL MUST belong to exactly one user.
  Requests for another user's data MUST return 404 and change nothing.
- An artist profile (memory, identity, brand guide) MUST be read and written only by the user
  linked to it. Unlinked users get no artist data.
- Caches and credentials MUST be keyed so they never cross users or channels. Quota state MUST
  be per user or channel, with one exception: the project-wide daily upload pool, which every
  approved user shares by design. When the pool is exhausted, the app returns a plain limit
  message and queues nothing.
- Platform credentials MUST be encrypted at rest and MUST NOT reach logs, traces or responses.

Rationale: the app is multi-user and becoming multi-artist; one leak breaks the product's trust.

### II. Truthful Output

- A publish is `VERIFIED` only after the platform's own read-back returns it.
- Audio numbers MUST come from ffmpeg. Model-emitted numerics MUST be stripped.
- Hashtags and tags MUST come from the job's candidate lists. Anything else is rejected.
- UI text is plain labels. No persona or chatbot copy.
- Description voice MUST be grounded in the artist's own writing, never invented. The only
  exception is peer influence the artist explicitly chooses through saved per-role settings.
  Copied peer sentences or distinctive phrases MUST NOT appear.
- Nathan's surname MUST NOT be written in code, fixtures, prompts, commits or docs, and MUST NOT
  be filtered from runtime data.

### III. One Service, One Model Provider, Page-Driven

- One Cloud Run service and one model provider. No added services, queues, functions or
  background workers, with two exceptions:
  - Research and learning stages (spec 005) MAY run server-side, independent of the browser.
    Their plan chooses the mechanism.
  - One scheduled database retention job deletes expired YouTube statistics (Platform Terms).
- Every other pipeline step advances one step per page request, each under about 2 minutes,
  claimed in a database transaction.
- A cold or busy dependency, or a missing or revoked user grant, MUST return a wait reason
  immediately. A wait never fails a job. A rejected app credential is a failure.
- Outside the two exceptions, nothing runs unattended; the user's open page drives every step.

Rationale: one person watches each run; scale comes from raising instance limits, not new parts.

### IV. Domain-Grouped, Platform-Isolated Code

- Server code MUST live in domain folders under `src/lib/server/<domain>/` (for example `auth`,
  `jobs`, `pipeline`, `ai`, `media`). Tests mirror the same paths.
- Each external platform MUST live in its own folder, `src/lib/server/platforms/<name>/`.
  Platform API calls, scopes and error mapping MUST NOT appear outside it.
- The model provider is not a publishing platform. Its client lives in `src/lib/server/ai/`.
- Core domains reach a platform only through that folder's `index.ts`.
- A shared platform interface is extracted when the second platform lands, not before.
- Artist-specific values (name, voice, channel IDs) MUST NOT be constants in core code. They
  belong to the artist profile.

Rationale: the repo is growing to many artists and platforms. Placement rules keep each
addition local instead of spreading through every file.

### V. Tested at the Boundaries

- Coverage floors: 85% lines, functions and statements; 80% branches. Never lowered.
- Every new module gets positive, negative, error and edge-case tests.
- Mock only at process boundaries (GCS, Secret Manager, KMS, platform HTTP, the model
  provider's HTTP API, ffmpeg). Never mock internal modules.
- The database is never mocked. Tests run it as PGlite with the real migrations.
- E2E runs on desktop Chrome and Pixel 7 against the in-repo fakes.
- External service or library behavior that is not documented MUST be proven by a recorded
  manual gate before dependent code is built. Passing mocked tests does not close that gate.

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

## Platform Terms

- The app MUST NOT violate the YouTube API Services Terms of Service or Developer Policies.
- Every stored YouTube statistic, peer or the artist's own, MUST carry its retrieval time and
  MUST be kept at most 30 days. The database enforces it: statistics older than 30 days MUST be
  unreadable by the app and MUST be deleted daily, even while the app is idle.
- Until YouTube accepts the derived-metrics amendment, no number MAY be calculated from YouTube
  statistics, and no channel MAY be scored, ranked or grouped by its statistics.
- API data MUST NOT be aggregated across different content owners.

Rationale: a policy violation can cost the API access that uploads and verification depend on.

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

**Version**: 2.0.0 | **Ratified**: 2026-10-16 | **Last Amended**: 2026-10-22

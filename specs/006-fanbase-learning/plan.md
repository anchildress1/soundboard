# Implementation Plan: Learn what grows the fanbase

**Branch**: `006-fanbase-learning` | **Date**: 2026-10-25 (revised) | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-fanbase-learning/spec.md`

**Builds on**: `005-artist-branding` at `8eaedae`, on `004-artist-profile` at `7256ea4`:

- `artists` and `users.artist_id`; `artist_guides` with the approved brand row as the slider attach point (005 R10)
- `ownUploads` and `accessTokenFor` with the deadline; `identityFailure`; `budgetSignal`; `hasModelTime`
- `source: 'youtube'` span redaction and `AGENTS[agent].redactReply` (005 R4); the `reconnect YouTube` and `waiting on YouTube` waits
- `genrecleanup` with 005's proposal delete at 29 days; constitution 4.0.0

The branch is rebased onto that 005. T002 re-checks names against 005's and 004's merged code before T006.

## Summary

Each pick now draws on comparable artists and on the artist's own results, follows saved per-role peer-influence settings, and names its evidence. Research and learning keep running after the browser closes.

- **Runner:** one Cloud Tasks queue delivers each research batch as an ordinary request to the app's Cloud Run service. Each delivery is claimed, bounded by the 110 s step budget, and commits under its claim token. No new worker or poller; nothing runs without work (research R1, R2).
- **Environment (owner):** `anchildress1-unstable` is the whole 006 environment: its own service plus the queue, written into `deploy.sh` and `service.yaml` and never run. Production is untouched until the owner promotes (R17).
- **Flow:** the first `PICK` step starts a run and waits "Researching similar artists": learn → discover → match → releases, each in batches with a committed cursor. The pick proceeds when it's done, failed, or 10 minutes old. A research failure never fails the release (R3).
- **Peers:** a relevance search by genre, bracket placement before the cap (next first, same as fallback, two-up as secondary), then one `peer-match` call per candidate, hearing a 60 s clip of a public upload (gate G1) or matching on metadata, labeled either way (R4, R5, R7).
- **Evidence:** comparable peer releases (newest, most viewed, most engaged within each channel) replace the genre search's top videos as structure evidence. Each release adds its own labeled candidate list (R6).
- **Derived metrics (owner):** the owner states YouTube accepted the derived-metrics amendment. Brackets ship on; calculated numbers are computed in code and labeled "calculated"; statistics may go in prompts; a stat guard removes any statistic the model writes into a recommendation (R7).
- **Learning:** with the optional analytics grant, each public upload's first-28-day totals (Pacific dates, with confirmed coverage) are refreshed each run and linked to what was suggested and what was actually published (R8, R9).
- **Sliders:** five roles, 0–4, defaults with no setup, saved on the approved brand row, recorded on each draft, checked through cited sources. One re-ask per pick covers every check; a deterministic copy check bars peer sentences, distinctive phrases and names (R11, R12).
- **Terms:** every YouTube datum carries `retrieved_at`, is hidden at 29 days and deleted daily. Citations bind to immutable evidence rows. Revocation deletes outcomes, and no in-flight report can be saved after it. Sentry keeps no reply or reasoning from agents that can restate API data (R10, R14).
- **Governance:** constitution 4.0.0 → 5.0.0 records the owner's statement, plus PRD and AGENTS.md (R0).

## Technical Context

**Language/Version**: TypeScript strict, Node 24 (`.nvmrc`), SvelteKit 3, Svelte 5 runes

**Primary Dependencies**: existing only: Drizzle, `google-auth-library` (ADC token for Cloud Tasks, `verifyIdToken` for OIDC), `ai` 7.0.153 + `@ai-sdk/google` 4.0.105 (YouTube URL pass-through and static clips, gate G1), `p-retry`. Cloud Tasks and YouTube Analytics go through REST with `fetch`.

**Storage**: Neon Postgres through Drizzle. One generated migration, `fanbase_learning`:

- new tables `research_runs`, `job_research`, `artist_outcomes`, `peer_rejections`
- `artist_guides.influence`
- five `SECURITY DEFINER` write functions (three claim-guarded), an immutable shape checker, and the `connections_forget_outcomes` trigger
- policies and grants for `soundboard_app` and `soundboard_cleanup`

**Testing**:

- Vitest on PGlite with real migrations; Sentry through the global mock.
- Mocks only at process boundaries: YouTube Data, YouTube Analytics, Gemini, Cloud Tasks and Google certificate HTTP via `fetch`; `google-auth-library`; KMS.
- Playwright on desktop Chrome and Pixel 7 against `tests/e2e/fakes/`, plus a queue fake.
- One bounded live evaluation with fixed evidence (E1, research R15).

**Target Platform**: Cloud Run (one app service per environment, max 1 instance) plus one Cloud Tasks queue; current browsers, Pixel 7 primary.

**Project Type**: web application, a single SvelteKit project

**Performance Goals**:

- Each research delivery under 110 s, with 8 s reserved for the enqueue and the commit.
- A whole run is typically 6–10 deliveries, under 4 minutes. The pick waits at most 10 minutes.
- At most two provider calls per pick.

**Constraints**:

- YouTube data at most 30 days (hidden at 29). No aggregation across channels; no combined score.
- Every displayed number is as reported or computed in code and labeled "calculated". The model writes no statistic.
- No background work outside queue deliveries. The step deadline isn't restarted in helpers.
- Gemini live share $0.50 (R15). The surname is never written.

**Scale/Scope**: a handful of invited users; about 32 source files plus tests (inventory).

## Constitution Check

Gated against `.specify/memory/constitution.md` as 005 leaves it (4.0.0). Re-checked after the revised design: unchanged, with the amendment landing first in the same PR (T001).

| Principle                   | Status            | Notes                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Owned Data               | ✅                | New tables key on `owner_uid` or the caller's `users.artist_id` under RLS. A run can't be created for another user's job or artist. Deliveries run under the job owner's identity and match every delivery field. Another user's job and peers → 404.                                                                   |
| II. Truthful Output         | ✅                | Tags and hashtags only from candidate lists, now including per-release peer lists. ffmpeg-only audio numbers; the stat guard removes model-written statistics. Limits are server-built. Peer influence only through saved settings. Copied sentences, distinctive phrases and peer names are blocked deterministically. |
| III. Page-driven            | ⚠️ amend          | The research and learning exception, with Cloud Tasks as the mechanism. Waits never fail a run, and a research failure never fails a job. The retention job's scope widens. Fixed by 5.0.0 (R0).                                                                                                                        |
| IV. Domain-grouped          | ✅                | New domain `src/lib/server/research/`. YouTube Data and Analytics calls, the analytics scope and `analyticsShared` live in `platforms/youtube/`. Gemini stays in `ai/`.                                                                                                                                                 |
| V. Tested at the boundaries | ✅                | Positive, negative, error and edge tests per module; PGlite with real migrations. G1 proves YouTube URL clipping and pass-through before hearing code. G2 records Analytics shapes, including delayed data. Cloud Tasks and OIDC are documented, so they get a post-deploy check.                                       |
| VI. Simplicity              | ✅                | One queue, one handler, four stages, four tables, no stored lessons, no flags beyond `PEER_HEARING`, REST over new SDKs. Nothing kept for compatibility.                                                                                                                                                                |
| Platform Terms              | ⚠️ amend          | 5.0.0 replaces the derived-metrics prohibition with the owner's statement of acceptance and its rules (calculated labels, no model-written statistics, no combined score). 30-day storage and no cross-owner aggregation are unchanged. Analytics and peer-reference rules added.                                       |
| Media, Privacy and Secrets  | ⚠️ amend          | Sentry keeps no reply or reasoning from `peer-match` and `smart-pick` (005's pattern), added by 5.0.0.                                                                                                                                                                                                                  |
| Workflow: repo config       | ⚠️ needs approval | `service.yaml`, `deploy.sh`, `.env.example`, `vite.config.ts` (E2E alias), `README.md` env table. The brief allows spec-required config edits; listed in the report.                                                                                                                                                    |

## Inventory

Every place 006 touches, named as 004 and 005 leave it. Each is closed by a task.

| #   | File                                                                                                                                             | Change                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/lib/server/core/schema.ts`                                                                                                                  | 4 tables, `artist_guides.influence`, policies                                                                                                   |
| 2   | `drizzle/00NN_fanbase_learning.sql` (+ meta)                                                                                                     | generated; functions, trigger, grants appended                                                                                                  |
| 3   | `src/lib/server/core/genre-cleanup.ts`, `functions/genrecleanup.ts`                                                                              | 3 more deletes; response keys                                                                                                                   |
| 4   | `src/lib/server/core/env.ts`                                                                                                                     | `RESEARCH_QUEUE`, `RESEARCH_TASK_URL`, `RESEARCH_TASK_SA`, `PEER_HEARING`                                                                       |
| 5   | `src/lib/server/research/{runs,queue,delivery,learn,discover,match,releases,evidence,brackets,calculated}.ts` (new)                              | run state, Cloud Tasks, handler, stages, evidence I/O, brackets, calculated values                                                              |
| 6   | `src/lib/server/platforms/youtube/youtube.ts`, `connection.ts`, `index.ts`                                                                       | `searchVideos`, `channelsByIds`, `uploadsOf`, `ownUploads` + `status`, `ANALYTICS_SCOPE`, `analyticsShared`, `accessTokenFor` returns `grantAt` |
| 7   | `src/lib/server/platforms/youtube/analytics.ts` (new)                                                                                            | `videoReport`, `coverageDay`, `analyticsFailure`                                                                                                |
| 8   | `src/lib/server/auth/auth.ts`, `src/routes/auth/login/+server.ts`, `src/routes/auth/callback/+server.ts`                                         | purpose `analytics`                                                                                                                             |
| 9   | `src/lib/server/ai/model.ts`, `src/lib/server/core/tracing.ts`                                                                                   | agent `peer-match`; `youtube` part; labeled redaction; `redactReply` for `peer-match` and `smart-pick`; shared re-ask allowance                 |
| 10  | `src/lib/server/ai/peer-match.ts` (new)                                                                                                          | request, schema, validation                                                                                                                     |
| 11  | `src/lib/server/ai/smart-pick.ts`                                                                                                                | context (peers, releases, outcomes, influence), prompt rules, schema, finalize                                                                  |
| 12  | `src/lib/server/ai/{influence-check,copy-check,stat-guard}.ts` (new)                                                                             | FR-024; FR-022; FR-010                                                                                                                          |
| 13  | `src/lib/server/pipeline/pipeline.ts`                                                                                                            | `pick()`: start, wait, proceed, degrade; re-ask; `recordVerified` adoption                                                                      |
| 14  | `src/lib/server/pipeline/hashtags.ts`                                                                                                            | `CandidateList` gains `source` and `ref`                                                                                                        |
| 15  | `src/lib/server/jobs/{actions,jobs}.ts`                                                                                                          | approval pool per pool expiry; discard ends research; `createShort` keeps the evidence binding                                                  |
| 16  | `src/lib/server/jobs/view.ts`, `src/routes/jobs/[id]/+page.server.ts`                                                                            | review data                                                                                                                                     |
| 17  | `src/lib/server/artist/{memory,guides}.ts`                                                                                                       | publish record fields; `saveInfluence`, `approvedGuides` returns `influence`                                                                    |
| 18  | `src/lib/influence.ts` (new), `src/lib/types.ts`, `src/lib/status.ts`                                                                            | shapes, defaults, wait text                                                                                                                     |
| 19  | `src/routes/api/research/task/+server.ts`, `src/routes/api/influence/+server.ts`, `src/routes/api/jobs/[id]/peers/[ref]/reject/+server.ts` (new) | contract                                                                                                                                        |
| 20  | `src/hooks.server.ts`                                                                                                                            | exempt `POST /api/research/task`                                                                                                                |
| 21  | `src/routes/settings/+page.{server.ts,svelte}`, `src/lib/components/InfluenceSliders.svelte` (new)                                               | sliders                                                                                                                                         |
| 22  | `src/routes/connections/+page.{server.ts,svelte}`                                                                                                | Share analytics                                                                                                                                 |
| 23  | `src/lib/components/Review.svelte`, `src/routes/jobs/[id]/+page.svelte`, `src/lib/components/{Recommendation,Peers}.svelte` (new)                | review display, Not a peer                                                                                                                      |
| 24  | `src/routes/privacy/+page.svelte`                                                                                                                | analytics, peer research, 30-day deletion, disconnect, Sentry                                                                                   |
| 25  | `tests/e2e/fakes/{tasks.ts (new),fixtures.ts,youtube.ts}`, `vite.config.ts`                                                                      | queue fake alias, seeded runs                                                                                                                   |
| 26  | `service.yaml`, `deploy.sh`, `.env.example`, `README.md`                                                                                         | env, queue, IAM, APIs, unstable environment                                                                                                     |
| 27  | `.specify/memory/constitution.md`, `docs/prd.md`, `AGENTS.md`                                                                                    | R0                                                                                                                                              |
| 28  | `docs/operations/{youtube-retention.md,research-runner.md (new)}`, `docs/youtube-audit/{architecture,user-flows}.md`                             | ops and audit docs                                                                                                                              |
| 29  | `specs/006-fanbase-learning/{gates,eval}/`                                                                                                       | G1, G2, E1 scripts and results                                                                                                                  |

## Project Structure

### Documentation (this feature)

```text
specs/006-fanbase-learning/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/fanbase-learning.md
├── checklists/requirements.md
├── gates/{g1,g2}/            # created by T005, T035
├── eval/                     # created by T050
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── hooks.server.ts
├── lib/
│   ├── influence.ts (new), types.ts, status.ts
│   ├── components/{InfluenceSliders,Recommendation,Peers}.svelte (new), Review.svelte
│   └── server/
│       ├── research/ (new) runs, queue, delivery, learn, discover, match, releases, evidence, brackets, calculated
│       ├── ai/{model,smart-pick}.ts, peer-match.ts, influence-check.ts, copy-check.ts, stat-guard.ts (new)
│       ├── artist/{memory,guides}.ts
│       ├── auth/auth.ts
│       ├── core/{schema,env,tracing,genre-cleanup}.ts
│       ├── jobs/{actions,jobs,view}.ts
│       ├── pipeline/{pipeline,hashtags}.ts
│       └── platforms/youtube/{youtube,connection,index}.ts, analytics.ts (new)
├── routes/
│   ├── api/research/task/+server.ts (new)
│   ├── api/influence/+server.ts (new)
│   ├── api/jobs/[id]/peers/[ref]/reject/+server.ts (new)
│   ├── auth/{login,callback}/+server.ts
│   ├── connections/, settings/, jobs/[id]/, privacy/
functions/genrecleanup.ts
drizzle/00NN_fanbase_learning.sql (+ meta)
tests/
├── unit/ (mirrors src/; new research/*, ai/{peer-match,influence-check,copy-check,stat-guard}, platforms/youtube/analytics, routes/api/{research,influence,jobs/peers}, drizzle/fanbase-learning)
└── e2e/ (new research.spec.ts, influence.spec.ts; fakes/tasks.ts)
```

**Structure Decision**: the existing single SvelteKit project. Research is a new domain folder under `src/lib/server/` (constitution IV).

## Owner decisions and open items

Decided 2026-10-25 (spec Clarifications):

- **Q1 · Peer references after expiry:** internal refs only, bound to an immutable evidence row; "Peer evidence expired on <date>".
- **Q2 · Sliders without an approved brand guide:** defaults apply; saving waits for an approved brand guide.
- **Q3 · Default levels:** Sound 1, Feel 0, Wording 0, Discovery 4, Structure 4.
- **Q4 · Comparable release:** same side of 180 s, length within max(60 s, 25 %), published 14 days to 3 years before retrieval (R6).
- **Q5 · Rejections:** refreshed every discover; a rejection with no run for 29 days is deleted, and the peer can return.
- **Q6 · Derived metrics:** the owner states YouTube accepted the amendment. Brackets on; calculated numbers labeled; statistics allowed in prompts; the model writes none.
- **Q7 · `anchildress1-unstable`:** the whole 006 environment.

Open:

- **O1 · Acceptance record.** The plan relies on the owner's statement that YouTube accepted the derived-metrics amendment. Attach the acceptance (date and reference) to `docs/youtube-audit/` before the first deploy, so an audit can see the basis (T053).
- **O2 · Pick observability.** Redacting `smart-pick` replies in Sentry (Codex #3) removes the main agent's reply text from traces; prompts stay. Accepted by ruling; noted because debugging picks will lean on the stored pick instead.

## Complexity Tracking

| Violation                                                    | Why Needed                                                                          | Simpler Alternative Rejected Because                                                                                                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Cloud Tasks queue (III: "no added … queues")               | FR-003 and SC-006: research continues with the browser closed                       | Background work in the app gets no CPU after the response and dies with the instance. A Scheduler tick keeps Neon awake 24/7. A Cloud Run Job duplicates the runtime. Covered by III's exception; 5.0.0 names the mechanism (R1). |
| Retention job deletes more than statistics (III exception 2) | FR-015: peer metadata, outcomes and rejections are YouTube data with a 30-day limit | RLS hiding alone keeps the rows stored. A second job is a new part. Fixed by 5.0.0 (R0).                                                                                                                                          |
| A second app service in `anchildress1-unstable`              | Owner (Q7): the whole 006 environment is separate until promotion                   | Sharing the production service would expose untested research to production data. Same image, same `deploy.sh`; no new code path.                                                                                                 |

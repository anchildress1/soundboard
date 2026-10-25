# Implementation Plan: Learn what grows the fanbase

**Branch**: `006-fanbase-learning` | **Date**: 2026-10-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-fanbase-learning/spec.md`

**Builds on**: `005-artist-branding` at `e7f0356` (and through it `004-artist-profile` at `0a9176e`):

- `artists` and `users.artist_id`; `artist_guides` with the approved brand row as the slider attach point (005 R10)
- `ownUploads` and `accessTokenFor` with the deadline; `identityFailure`; `budgetSignal`; `hasModelTime`
- `source: 'youtube'` span redaction; the `reconnect YouTube` and `waiting on YouTube` waits
- `genrecleanup` with 005's proposal delete; constitution 4.0.0

005 predates 004's final rulings (`7256ea4`). Rebase onto the final 005 before code (T002).

## Summary

Each pick now draws on comparable artists and on the artist's own results, follows saved per-role peer-influence settings, and names its evidence. Research and learning keep running after the browser closes.

- **Runner:** one Cloud Tasks queue delivers each research stage as an ordinary request to the existing Cloud Run service. Each delivery is claimed and bounded by the 110 s step budget. No new service, worker or poller, and nothing runs while there's no work ([R1](research.md#r1--runner-mechanism-fr-003-sc-006), [R2](research.md#r2--delivery-protocol)). Config is written for `anchildress1-unstable` and never run.
- **Flow:** the first `PICK` step starts a run and waits "Researching similar artists". The run goes through four stages: learn → discover → match → releases. The pick proceeds when it's done, failed, or 10 minutes old ([R3](research.md#r3--when-research-runs-and-how-the-pick-waits)).
- **Peers:** chosen by sound and genre only. A relevance search, then one `peer-match` call per candidate that hears a 60 s clip of a public YouTube upload (gate G1) or matches on metadata, labeled either way. Labels, compilations, curators and uncertain matches are skipped ([R4](research.md#r4--peer-discovery-fr-016-fr-018), [R5](research.md#r5--matching-and-hearing-fr-018-gate-g1)).
- **Evidence:** peer releases replace the genre search's top videos as structure evidence. Each release adds its own labeled candidate list. Statistics are stored as reported, shown in review, and never put in a prompt ([R6](research.md#r6--peer-releases-and-evidence-fr-005-fr-020)).
- **Brackets:** built and tested behind `BRACKETS_ENABLED`, off. They need YouTube's amendment and a constitution change ([R7](research.md#r7--brackets-behind-a-flag-fr-016fr-019)).
- **Learning:** with the optional analytics grant, the artist's public uploads' first-28-day views and subscribers gained and lost, as reported, are refreshed each run. They're linked to what was adopted ([R8](research.md#r8--learning-from-the-artists-results-fr-001-fr-004-fr-007-fr-010-fr-015), [R9](research.md#r9--analytics-consent-and-the-oauth-scope-fr-002)).
- **Sliders:** five roles, 0–4, defaults that work with no setup. Saved on the approved brand row, recorded on each draft, and checked through the draft's cited sources, with one re-ask then a warning. A deterministic copy check bars peer sentences and names ([R11](research.md#r11--sliders-storage-defaults-and-the-005-open-question-fr-021-fr-023-fr-025), [R12](research.md#r12--pick-sources-citations-influence-check-copy-check-fr-006-fr-008-fr-009-fr-022-fr-024-fr-025)).
- **Terms:** every YouTube datum carries `retrieved_at`, is hidden at 30 days and deleted daily. Long-lived records point at peers only through expiring evidence. Revocation deletes outcomes ([R10](research.md#r10--youtube-terms-and-retention-fr-012-fr-015-sc-008)).
- **Governance:** constitution 4.0.0 → 5.0.0, plus PRD and AGENTS.md ([R0](research.md#r0--governance-gate)).

## Technical Context

**Language/Version**: TypeScript strict, Node 24 (`.nvmrc`), SvelteKit 3, Svelte 5 runes

**Primary Dependencies**: existing only: Drizzle, `google-auth-library` (ADC access token for Cloud Tasks, `verifyIdToken` for OIDC), `ai` 7.0.153 + `@ai-sdk/google` 4.0.105 (Interactions model: YouTube URL pass-through and static clip processing, gate G1), `p-retry`. No new packages: Cloud Tasks and YouTube Analytics go through REST with `fetch`.

**Storage**: Neon Postgres through Drizzle. One generated migration, `fanbase_learning`:

- new tables `research_runs`, `job_research`, `artist_outcomes`, `peer_rejections`
- `artist_guides.influence`
- five `SECURITY DEFINER` write functions, an immutable shape checker, and the `connections_forget_outcomes` trigger
- policies and grants for `soundboard_app` and `soundboard_cleanup`

**Testing**:

- Vitest on PGlite with real migrations; Sentry through the global mock.
- Mocks only at process boundaries: YouTube Data, YouTube Analytics, Gemini, Cloud Tasks and Google certificate HTTP via `fetch`; `google-auth-library`; KMS.
- Playwright on desktop Chrome and Pixel 7 against `tests/e2e/fakes/`, plus a new queue fake.

**Target Platform**: Cloud Run (one service, max 1 instance) plus one Cloud Tasks queue; current browsers, Pixel 7 primary.

**Project Type**: web application, a single SvelteKit project

**Performance Goals**:

- Each research delivery under 110 s.
- A whole run is typically 4–6 deliveries, under 3 minutes.
- The pick waits at most 10 minutes for research.

**Constraints**:

- No YouTube statistic in a prompt or in long-lived storage. No number calculated from statistics.
- No cross-channel totals; no peer names or IDs past 30 days.
- No background work outside queue deliveries. The step deadline isn't restarted in helpers.
- Gemini live share $0.50 (R15). The surname is never written.

**Scale/Scope**: a handful of invited users; about 30 source files plus tests ([inventory](#inventory)).

## Constitution Check

Gated against `.specify/memory/constitution.md` as 005 leaves it (4.0.0). Re-checked after Phase 1 design: unchanged, with the amendment landing first in the same PR (T001).

| Principle                   | Status            | Notes                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Owned Data               | ✅                | New tables key on `owner_uid` or the caller's `users.artist_id` under RLS. Deliveries run under the job owner's identity. Another user's job and peers → 404. Credentials stay in `connections` and KMS. Quota state per job and artist, except the existing project pools.                                                                                                  |
| II. Truthful Output         | ✅                | Tags and hashtags only from candidate lists, now including per-release peer lists. ffmpeg-only numbers; model numerics stripped from recommendations. Limits are server-built. Peer influence only through the artist's saved settings (II's existing exception); defaults keep Feel and Wording at 0. Copied peer sentences and names are blocked by a deterministic check. |
| III. Page-driven            | ⚠️ amend          | The research and learning exception is used as written; the plan chooses Cloud Tasks deliveries. Waits never fail a run. The retention job's scope widens to peer research, outcomes and rejections. Fixed by 5.0.0, which also names the mechanism (R0).                                                                                                                    |
| IV. Domain-grouped          | ✅                | New domain `src/lib/server/research/`. YouTube Data and Analytics calls and the analytics scope live in `platforms/youtube/` behind `index.ts`. Gemini stays in `ai/`. No artist value in code.                                                                                                                                                                              |
| V. Tested at the boundaries | ✅                | Positive, negative, error and edge tests per module; PGlite with real migrations. Gate G1 proves the undocumented YouTube URL clipping and pass-through before hearing code. G2 records Analytics shapes. Cloud Tasks and OIDC behavior is documented, so it gets a post-deploy check, not a gate.                                                                           |
| VI. Simplicity              | ✅                | One queue, one handler, four stages, four tables, no stored lessons, REST over new SDKs. Brackets are behind a flag by owner decision, isolated in one module. Nothing kept for compatibility.                                                                                                                                                                               |
| Platform Terms              | ⚠️ amend          | 30-day hide and daily delete on every new YouTube datum. Analytics only with the optional grant, deleted on revocation. No calculation or grouping by statistics while the flag is off. No cross-owner aggregation. 5.0.0 adds the Analytics and peer-reference rules. Spec FR-015's "keep the peer reference" is met with internal references only (R10, Q1).               |
| Workflow: repo config       | ⚠️ needs approval | `service.yaml`, `deploy.sh`, `.env.example`, `vite.config.ts` (E2E alias), `README.md` env table. Listed in tasks; the brief allows spec-required config edits.                                                                                                                                                                                                              |

## Inventory

Every place 006 touches, named as 004 and 005 leave it. The implementation must close each one.

| #   | File                                                                                                                                             | Change                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/lib/server/core/schema.ts`                                                                                                                  | 4 tables, `artist_guides.influence`, policies (data-model)                                                                                                        |
| 2   | `drizzle/00NN_fanbase_learning.sql` (+ meta)                                                                                                     | generated; functions, trigger, grants appended                                                                                                                    |
| 3   | `src/lib/server/core/genre-cleanup.ts`, `functions/genrecleanup.ts`                                                                              | 3 more deletes; response keys                                                                                                                                     |
| 4   | `src/lib/server/core/env.ts`                                                                                                                     | `RESEARCH_QUEUE`, `RESEARCH_TASK_URL`, `RESEARCH_TASK_SA`, `BRACKETS_ENABLED`, `PEER_HEARING`                                                                     |
| 5   | `src/lib/server/research/{runs,queue,delivery,learn,discover,match,releases,evidence,brackets}.ts` (new)                                         | run state, Cloud Tasks, handler, stages, evidence I/O, brackets                                                                                                   |
| 6   | `src/lib/server/platforms/youtube/youtube.ts`, `index.ts`                                                                                        | `searchVideos(query, { order })`, `channelsByIds`, `uploadsOf(playlist, n, deadline)`, `ownUploads` gains `status`, `ANALYTICS_SCOPE`, deadline on every key read |
| 7   | `src/lib/server/platforms/youtube/analytics.ts` (new)                                                                                            | `videoReport(token, videoId, start, end, deadline)`, `analyticsFailure`                                                                                           |
| 8   | `src/lib/server/auth/auth.ts`, `src/routes/auth/login/+server.ts`, `src/routes/auth/callback/+server.ts`                                         | purpose `analytics`                                                                                                                                               |
| 9   | `src/lib/server/ai/model.ts`, `src/lib/server/core/tracing.ts`                                                                                   | agent `peer-match`; `youtube` part with static processing; labeled redaction                                                                                      |
| 10  | `src/lib/server/ai/peer-match.ts` (new)                                                                                                          | request, schema, validation                                                                                                                                       |
| 11  | `src/lib/server/ai/smart-pick.ts`                                                                                                                | context (peers, releases, outcomes, influence), prompt rules, schema (citations, recommendation), finalize (refs, limits, peer-name replacement)                  |
| 12  | `src/lib/server/ai/influence-check.ts`, `src/lib/server/ai/copy-check.ts` (new)                                                                  | FR-024 check; FR-022 copy check                                                                                                                                   |
| 13  | `src/lib/server/pipeline/pipeline.ts`                                                                                                            | `pick()`: start, wait, proceed; peers and outcomes into the pick; re-asks; `recordVerified` adds recommendation                                                   |
| 14  | `src/lib/server/pipeline/hashtags.ts`                                                                                                            | `CandidateList` gains `source: 'genre' \| 'peer'` and `ref`                                                                                                       |
| 15  | `src/lib/server/jobs/actions.ts`                                                                                                                 | approval union includes fresh peer lists; re-run drops rejected peers                                                                                             |
| 16  | `src/lib/server/jobs/view.ts`, `src/routes/jobs/[id]/+page.server.ts`                                                                            | review data: resolved citations, peers, expired refs                                                                                                              |
| 17  | `src/lib/server/artist/memory.ts`, `src/lib/server/artist/guides.ts`                                                                             | publish record fields; `saveInfluence`, `approvedGuides` returns `influence`                                                                                      |
| 18  | `src/lib/influence.ts` (new), `src/lib/types.ts`, `src/lib/status.ts`                                                                            | shapes, defaults, wait text                                                                                                                                       |
| 19  | `src/routes/api/research/task/+server.ts`, `src/routes/api/influence/+server.ts`, `src/routes/api/jobs/[id]/peers/[ref]/reject/+server.ts` (new) | contract                                                                                                                                                          |
| 20  | `src/hooks.server.ts`                                                                                                                            | exempt `POST /api/research/task` from the session gate                                                                                                            |
| 21  | `src/routes/settings/+page.{server.ts,svelte}`, `src/lib/components/InfluenceSliders.svelte` (new)                                               | sliders                                                                                                                                                           |
| 22  | `src/routes/connections/+page.{server.ts,svelte}`                                                                                                | Share analytics                                                                                                                                                   |
| 23  | `src/lib/components/Review.svelte`, `src/routes/jobs/[id]/+page.svelte`, `src/lib/components/{Recommendation,Peers}.svelte` (new)                | review display, Not a peer                                                                                                                                        |
| 24  | `src/routes/privacy/+page.svelte`                                                                                                                | analytics, peer research, 30-day deletion, disconnect deletes results                                                                                             |
| 25  | `tests/e2e/fakes/{tasks.ts (new),fixtures.ts,youtube.ts}`, `vite.config.ts`                                                                      | queue fake alias, seeded runs                                                                                                                                     |
| 26  | `service.yaml`, `deploy.sh`, `.env.example`, `README.md`                                                                                         | env, queue, IAM, APIs (config, approval listed)                                                                                                                   |
| 27  | `.specify/memory/constitution.md`, `docs/prd.md`, `AGENTS.md`                                                                                    | R0                                                                                                                                                                |
| 28  | `docs/operations/{youtube-retention.md,research-runner.md (new)}`, `docs/youtube-audit/{architecture,user-flows}.md`                             | ops and audit docs                                                                                                                                                |

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
├── gates/{g1,g2}/            # created by T005, T033
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
│       ├── research/ (new) runs, queue, delivery, learn, discover, match, releases, evidence, brackets
│       ├── ai/{model,smart-pick}.ts, peer-match.ts, influence-check.ts, copy-check.ts (new)
│       ├── artist/{memory,guides}.ts
│       ├── auth/auth.ts
│       ├── core/{schema,env,tracing,genre-cleanup}.ts
│       ├── jobs/{actions,view}.ts
│       ├── pipeline/{pipeline,hashtags}.ts
│       └── platforms/youtube/{youtube,index}.ts, analytics.ts (new)
├── routes/
│   ├── api/research/task/+server.ts (new)
│   ├── api/influence/+server.ts (new)
│   ├── api/jobs/[id]/peers/[ref]/reject/+server.ts (new)
│   ├── auth/{login,callback}/+server.ts
│   ├── connections/, settings/, jobs/[id]/, privacy/
functions/genrecleanup.ts
drizzle/00NN_fanbase_learning.sql (+ meta)
tests/
├── unit/ (mirrors src/; new research/*, ai/{peer-match,influence-check,copy-check}, platforms/youtube/analytics, routes/api/{research,influence,jobs/peers}, drizzle/fanbase-learning)
└── e2e/ (new research.spec.ts, influence.spec.ts; fakes/tasks.ts)
```

**Structure Decision**: the existing single SvelteKit project. Research is a new domain folder under `src/lib/server/` (constitution IV). YouTube Data and Analytics stay in `platforms/youtube/`.

## Open questions for the owner

Real product ambiguities. The plan takes the safe default shown; each is cheap to change before the task named.

- **Q1 · Peer references after 30 days (FR-015 vs Developer Policies III.E.4.d), before T009 and T024.** The spec keeps "the peer reference" on citations past 30 days, but channel and video IDs are API data with no exemption. **Default:** long-lived citations hold an internal pointer only; after expiry, review shows "Peer evidence expired on <date>" with no name or ID. If the owner has a policy reading that allows IDs, citations could keep `channelId`.
- **Q2 · Sliders without an approved brand guide (005 Q2), before T022.** **Default:** defaults apply; saving needs an approved brand guide (R11). Alternative: `artists.influence`, saving for everyone but breaking 005 FR-012 and 006 FR-023 as written.
- **Q3 · Default slider levels, before T022.** The spec gives each role's sources, not levels. **Default:** Sound 1, Feel 0, Wording 0, Discovery 4, Structure 4 (R11).
- **Q4 · Comparable release, before T019.** **Default:** same YouTube length bucket as the upload, published 14 days to 3 years before retrieval, the 3 newest eligible per peer (R6). The spec leaves "comparable" to planning; the owner may want different windows.
- **Q5 · Rejections that lapse, before T017.** A rejected peer is kept only while research keeps refreshing it (every run). After 30 days with no run, the rejection is deleted, and the peer can come back. That's required by III.E.4.d; the owner may prefer a different refresh cadence.
- **Q6 · Recommendation text derived from the artist's own statistics, before T036.** The model reads the artist's reported numbers and writes a qualitative recommendation, with model numerics stripped. The plan treats that as allowed: no number is calculated and no channel is ranked. If the owner reads III.E.4.h(ii) more strictly, outcomes stay display-only until the amendment.
- **Q7 · `anchildress1-unstable` scope.** Default: it's the whole 006 environment (service, queue, its own Neon branch and OAuth client), deployed by the same `deploy.sh` with `GCP_PROJECT_ID` set. If only the queue should live there beside the production service, the IAM in R2 changes to cross-project.

## Complexity Tracking

| Violation                                                    | Why Needed                                                                          | Simpler Alternative Rejected Because                                                                                                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Cloud Tasks queue (III: "no added … queues")               | FR-003 and SC-006: research continues with the browser closed                       | Background work in the app gets no CPU after the response and dies with the instance. A Scheduler tick keeps Neon awake 24/7. A Cloud Run Job duplicates the runtime. Covered by III's exception; 5.0.0 names the mechanism (R1). |
| Retention job deletes more than statistics (III exception 2) | FR-015: peer metadata, outcomes and rejections are YouTube data with a 30-day limit | RLS hiding alone keeps the rows stored. A second job is a new part. Fixed by 5.0.0 (R0).                                                                                                                                          |
| Bracket code that production never runs                      | Brief: ship the bracket features behind a flag, off                                 | Not building it means a second design pass after acceptance. It's isolated in one module with its own tests.                                                                                                                      |

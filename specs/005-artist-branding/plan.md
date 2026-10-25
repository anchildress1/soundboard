# Implementation Plan: Per-artist voice and brand guide

**Branch**: `005-artist-branding` | **Date**: 2026-10-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-artist-branding/spec.md`

**Builds on**: `004-artist-profile` at `0a9176e`: `artists` + `users.artist_id`, the migration-only `artists.curated` flag, owner-grant `ownUploads(token, channelId, count, deadline)`, the `reconnect YouTube` wait on a missing or revoked grant, `GENERIC_VOICE` with "Write no credit line", the app-placed contact line, `[YouTube uploads: <n>]` span redaction, brand `uploadCount`, the 110 s deadline threaded through YouTube reads, and constitution 3.0.0 with temporary II and IV exceptions. Rebased onto 004's final version again before implementation (T032).

## Summary

Every artist gets their own writing voice and brand guide, proposed from their own writing and used only after they approve it.

- **Storage:** one new table, `artist_guides`: per artist and kind (`voice` | `brand`), at most one proposal and one approved version ([R1](research.md#r1--where-voice-and-brand-live)).
- **Nathan:** the migration turns `ARTIST_VOICE` (plus his credit wording) and his approved brand guide into his approved rows, then drops `artists.curated`. `ARTIST_VOICE` is deleted from code ([R2](research.md#r2--nathans-voice-and-brand-become-data-curated-goes)).
- **Retention:** proposals list the uploads they read and expire at 30 days, hidden by RLS and deleted by the existing daily job. Approved rows keep counts only, enforced by a `CHECK` ([R4](research.md#r4--youtube-retention-fr-003-fr-004-sc-004)).
- **Proposals:** one page-driven request each, under the shared step deadline. Voice reads the owner's own descriptions and Soundboard edits; brand reads uploads and thumbnails. Both through the owner's grant ([R5](research.md#r5--voice-proposal-inputs-and-limits), [R8](research.md#r8--page-driven-proposal-steps-under-the-deadline)).
- **Race:** approve and discard name the proposal row; the loser gets a 409 and keeps its text ([R9](research.md#r9--the-two-tab-approval-race)).
- **Picks:** the owner's approved voice, else `GENERIC_VOICE`, followed by a content-rules line that outranks it ([R7](research.md#r7--how-a-pick-uses-them-fr-005fr-008-sc-002-sc-003)).
- **Spec 006:** sliders attach to the approved brand row; approvals update named columns only ([R10](research.md#r10--where-spec-006s-sliders-attach-fr-012)).
- **Governance:** constitution 3.0.0 → 4.0.0 (MAJOR): 004's temporary II and IV exceptions removed, II's voice rule and III's retention exception redefined. Plus PRD and AGENTS.md ([R12](research.md#r12--prd-agentsmd-and-constitution-fr-013)).

## Technical Context

**Language/Version**: TypeScript strict, Node 24 (`.nvmrc`), SvelteKit 3, Svelte 5 runes

**Primary Dependencies**: existing only: Drizzle, `google-auth-library`, `ai` + `@ai-sdk/google`, `p-retry`. No new packages.

**Storage**: Neon Postgres through Drizzle. One generated migration (`artist_guides`): the table, checks, policies, grants, `soundboard_save_proposal` (the only proposal writer), the data block, the `artist_memory` kind change, and `DROP COLUMN curated`.

**Testing**:

- Vitest on PGlite with real migrations; no database mocks; Sentry through the global mock.
- Mocks only at process boundaries: YouTube and Gemini HTTP via `fetch`, KMS.
- Playwright on desktop Chrome and Pixel 7 against `tests/e2e/fakes/` (the Gemini preload answers 429, so proposals end at `model busy`).

**Target Platform**: Cloud Run (one service), current browsers; Pixel 7 primary.

**Project Type**: web application, a single SvelteKit project

**Performance Goals**: SC-001: propose to approved voice and brand guide in under 5 minutes. Each proposal is one request inside the 110 s deadline, typically under 40 s.

**Constraints**:

- No artist's voice in code (constitution IV); `GENERIC_VOICE` is generic, not an artist's.
- No YouTube data kept past 30 days; no statistic fetched or stored (FR-004).
- No new service, queue or worker. The existing daily retention function gains one statement.
- The step deadline isn't restarted in helpers.
- The surname is never written.
- Gemini: about $0.07 per voice proposal and $0.05 per brand proposal at current Argon prices.

**Scale/Scope**: a handful of invited users. About 25 source files plus tests ([inventory](#inventory)).

## Constitution Check

Gated against `.specify/memory/constitution.md` as 004 leaves it (3.0.0, with temporary II and IV exceptions naming spec 005). Re-checked after Phase 1 design: unchanged, with the amendment below landing first in the same PR.

| Principle                   | Status   | Notes                                                                                                                                                                                                                                                                          |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I. Owned Data               | ✅       | `artist_guides` RLS keys on the caller's own `users.artist_id`. Routes key on `locals.user.artist.id`; another user's guide is a 404. YouTube inputs are read only through the owner's grant and shown only to them (III.E.3.b).                                               |
| II. Truthful Output         | ✅       | Sources are computed by the server, not the model. Tags, numerics and length limits keep their `finalizePick` enforcement; the content-rules line outranks the voice (FR-008). Plain labels.                                                                                   |
| II. Voice grounded          | ⚠️ amend | Voice comes from the artist's own writing, approved by them. `GENERIC_VOICE` (no approved voice) isn't grounded in anyone's writing; 3.0.0 allows it only as 004's temporary exception, which ends with 005. Fixed by the 4.0.0 amendment.                                     |
| III. Page-driven            | ⚠️ amend | Proposals are page-driven steps under the shared deadline; a missing or revoked grant returns `reconnect YouTube`. The retention job's exception names statistics only; it now also deletes expired proposals. Fixed by the 4.0.0 amendment.                                   |
| IV. Domain-grouped          | ✅       | `ARTIST_VOICE` and the credit wording leave core code, so 004's temporary IV exception is removed. New code in `server/artist/` (domain); YouTube calls stay in `platforms/youtube/` through `index.ts`.                                                                       |
| V. Tested at the boundaries | ✅       | Positive, negative, error and edge tests per module; RLS, migration and cleanup on PGlite. No undocumented external behavior is relied on: `playlistItems`/`videos.list` are documented, and the model's rule quality is a post-release check (SC-005).                        |
| VI. Simplicity              | ✅       | One table, one save function (the `soundboard_save_audience` pattern), one generic module for both kinds, one extra `DELETE` in the existing job. `/api/brand/*`, `StoredBrand`, `uploadCount`, `ARTIST_VOICE` and `curated` are deleted with no alias. Nothing added for 006. |
| Platform Terms              | ⚠️ amend | Proposals: Authorized Data ≤ 30 days, database-enforced (III.E.4.c). Approved: counts only (`CHECK`). The amendment writes this into Platform Terms. Proposal reads are not identity reads, so 004's no-store rule doesn't apply; AGENTS.md says so (T003).                    |
| Workflow: repo config       | ✅       | No config file changes. `functions/genrecleanup.ts` is app code; its redeploy is an operator step under the deployment freeze.                                                                                                                                                 |

**Amendment** (task T001, `/speckit-constitution`, first commit of the PR): 3.0.0 → **4.0.0, MAJOR**. Exact wording and the classification reasoning: [research R12](research.md#r12--prd-agentsmd-and-constitution-fr-013).

## Inventory

Every place the single-artist voice or brand guide lives after 004, plus the retention job. The implementation must touch each one.

| #   | File                                                                                      | Today (after 004)                                                         | Change                                                                                          |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | `src/lib/server/ai/smart-pick.ts`                                                         | `ARTIST_VOICE`, curated credit block, `artist.curated`                    | Delete all three; `voice: VoiceRules \| null`; `voiceBlock()`; content-rules line (R7).         |
| 2   | `src/lib/server/pipeline/pipeline.ts`                                                     | `approvedBrand(artist.id)` when `curated`                                 | `approvedGuides(artist.id)` when `artistJob`; pass `voice` and `brand`.                         |
| 3   | `src/lib/server/artist/brand.ts`                                                          | slots in `artist_memory`, `requireCurated`, `uploadCount`                 | Brand prompt and cleaning only; storage moves to `guides.ts`; `requireCurated` removed.         |
| 4   | `src/lib/server/artist/voice.ts` (new)                                                    | none                                                                      | Voice evidence, request, schema, cleaning, `proposeVoice` (R5).                                 |
| 5   | `src/lib/server/artist/guides.ts` (new)                                                   | none                                                                      | Table access, propose upsert, approve and discard with `proposalId` (R9).                       |
| 6   | `src/lib/server/artist/memory.ts`                                                         | `kind` includes `brand`                                                   | `brand` removed; `recentFeedback(artistId, limit)` used by voice.                               |
| 7   | `src/lib/server/artist/profile.ts`                                                        | `ArtistProfile.curated`                                                   | Field removed; `requireArtist(user)` lives here (404 without a profile).                        |
| 8   | `src/lib/server/core/schema.ts`                                                           | `artists.curated`, `artist_memory.kind` with `brand`                      | `artistGuides` table; drop `curated`; kind enum without `brand`.                                |
| 9   | `src/lib/server/core/genre-cleanup.ts`, `functions/genrecleanup.ts`                       | deletes expired `job_audience` only                                       | Also deletes expired proposals; response gains `proposals`.                                     |
| 10  | `src/lib/server/ai/model.ts`, `src/lib/server/core/tracing.ts`                            | four agents                                                               | Add `voice-guide`.                                                                              |
| 11  | `src/lib/brand.ts`                                                                        | `StoredBrand`, brand limits                                               | Voice types and limits, `voiceError`, `Proposal`, `Approved`, `GuideState`; `StoredBrand` gone. |
| 12  | `src/lib/api.ts`                                                                          | `proposeBrand`, `approveBrand(guide, proposedAt)`, `discardBrandProposal` | `proposeGuide(kind)`, `approveGuide(kind, body, proposalId)`, `discardGuide(kind, proposalId)`. |
| 13  | `src/routes/api/brand/{propose,approve,discard}/+server.ts`                               | brand-only routes                                                         | Deleted; `src/routes/api/guides/[kind=guide]/{propose,approve,discard}/+server.ts`.             |
| 14  | `src/params/guide.ts` (new)                                                               | none                                                                      | Matcher `voice \| brand`.                                                                       |
| 15  | `src/routes/brand/+page.server.ts`, `+page.svelte`                                        | brand only, `requireCurated`                                              | Voice and Brand guide sections; `requireArtist`.                                                |
| 16  | `src/lib/components/VoiceGuide.svelte`, `BrandGuide.svelte` (new)                         | brand form inline in the page                                             | One component per kind; shared propose loop in `src/lib/propose.ts` (new).                      |
| 17  | `src/routes/+layout.svelte`, `+layout.server.ts`                                          | "Brand guide" link when `curated`                                         | "Brand" for every user with a profile; layout data drops `curated`.                             |
| 18  | `src/routes/privacy/+page.svelte`                                                         | brand guide for the curated profile                                       | Voice and brand proposals (deleted after 30 days) and approved rules for every artist.          |
| 19  | `tests/e2e/brand.spec.ts`, `tests/e2e/fakes/{fixtures,youtube}.ts`                        | Nathan-only brand                                                         | Non-Nathan user C's page, both sections, race message.                                          |
| 20  | `docs/prd.md`, `AGENTS.md`, `.specify/memory/constitution.md`                             | Nathan's voice in code                                                    | FR-013 (R12).                                                                                   |
| 21  | `docs/operations/youtube-retention.md`, `docs/youtube-audit/architecture.md`, `README.md` | research-only retention; Nathan-only brand                                | Proposal retention; per-artist brand page.                                                      |

## Project Structure

### Documentation (this feature)

```text
specs/005-artist-branding/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/artist-guides.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── params/guide.ts                          # new
├── lib/
│   ├── brand.ts, api.ts, propose.ts (new)
│   ├── components/{VoiceGuide,BrandGuide}.svelte   # new
│   └── server/
│       ├── artist/{guides.ts (new), voice.ts (new), brand.ts, memory.ts, profile.ts}
│       ├── ai/{smart-pick.ts, model.ts}
│       ├── core/{schema.ts, tracing.ts, genre-cleanup.ts}
│       └── pipeline/pipeline.ts
├── routes/
│   ├── +layout.svelte, +layout.server.ts
│   ├── api/guides/[kind=guide]/{propose,approve,discard}/+server.ts   # new
│   ├── brand/+page.server.ts, +page.svelte
│   └── privacy/+page.svelte
functions/genrecleanup.ts
drizzle/
└── 00NN_artist_guides.sql (+ meta)          # generated after 004; data block inserted
tests/
├── unit/  (mirrors src/; new: server/artist/{guides,voice}.test.ts, routes/api/guides/**, drizzle/artist-guides.test.ts)
└── e2e/brand.spec.ts
```

**Structure Decision**: the existing single SvelteKit project. Domain code in `src/lib/server/artist/`; YouTube stays behind `platforms/youtube/index.ts` (constitution IV).

## Open questions for the owner

Real product ambiguities. The plan picks the safe default shown and moves on; each is cheap to change before T014.

- **Q1 · Two-tab race.** "Latest approval wins": read as "the last approval to commit is active; an approve or discard of a proposal another tab already approved, discarded or replaced gets a 409 and keeps its text." If the second tab's edits should overwrite the first tab's approval of the same proposal, R9 changes.
- **Q2 · Sliders without a brand guide.** 006 FR-021 needs working defaults with no setup, and FR-023 saves sliders "with their brand guide". 005 FR-012 says the _approved_ guide. An artist with no approved guide has nowhere to save sliders. 006's plan must decide: require an approved guide first, or a separate row.
- **Q3 · Soundboard-drafted uploads as voice evidence.** Default: excluded, since Soundboard wrote them; the artist's edits to them count. Most of Nathan's recent uploads are Soundboard drafts, so his next proposal reads few descriptions.
- **Q4 · Nathan's credit wording.** 004 gated the "hacked and slashed" credit example on `curated`. Default: it becomes the ninth rule of his approved voice, editable by him. The alternative is a profile field for a credit line, which 004's form doesn't have.

## Complexity Tracking

| Violation                                                                                                  | Why Needed                                                     | Simpler Alternative Rejected Because                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| II bars ungrounded voice once 004's temporary exception ends; `GENERIC_VOICE` stays for unapproved artists | FR-006: generic rules until the artist approves their own      | Proposing a voice automatically breaks FR-005. Fix: amendment 4.0.0 (T001), before any code task.                       |
| III retention exception covers statistics only                                                             | FR-004: proposals hold Authorized Data that must go at 30 days | RLS hiding alone keeps the rows stored past 30 days; a second scheduled job is a new part. Fix: amendment 4.0.0 (T001). |

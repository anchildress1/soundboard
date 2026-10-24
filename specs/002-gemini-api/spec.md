# Feature Specification: Gemini API in place of self-hosted Gemma

**Feature Branch**: `002-gemini-api`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "Swap from hosted Gemma to a hosted model API and drop the Vertex payment. Send the whole video, not frames. Flash for chunks, a top-tier model for picks. Stream the video in rather than passing bytes through the app. Imitate the existing functionality." The artist band-name field is spec 004; it feeds the model too, so it follows this swap.

## Clarifications

### Session 2026-10-21

- Q: Which provider? → A: Gemini API. Claude was considered first and dropped: it takes no audio, and the analysis has to hear the music.
- Q: Frames or the whole video? → A: Video, not frames. No frame or audio extraction for the model; each window goes as a short video clip with its sound.
- Q: What does "stream" mean? → A: Video comes from cloud storage. The plan was for the provider to read the upload directly, but gate G1 showed that's far too slow on large files. So each window is cut into a small clip and sent with the call (Session 2026-10-22). Replies arrive whole.
- Q: One call for the whole video, or per window? → A: Per window. Each analyze step sends one clip of the stored video, so chunk N/M and the ~2-minute step budget stay.
- Q: Which models? → A: Analyst: `gemini-3.8-flash`, switchable by configuration to `gemini-3.5-flash-lite`. Smart pick, hook pick, brand guide: `gemini-4-argon`.
- Q: Which SDK? → A: A provider-agnostic one. Agent features are coming, and the pick models may move to another provider later, so a swap must be configuration plus one client file. The analyst stays on Gemini because only Gemini hears audio.
- Q: Which tier? → A: Paid only. The free tier uses content to improve Google's products; unreleased music must not go there.

### Session 2026-10-22

- Q: Gate G1 failed on large files. What now? → A: Each analyze step cuts its window into a small 360p clip and sends it with the call. On the 2 GB test file, the registered upload took 120–255 s per call; the inline clip took 6.4 s.
- Q: Window length now that Gemma's 30 s audio cap is gone? → A: 60 s.

### Session 2026-10-23

- Q: Do AI drafts informed by YouTube API data count as "new or derived data" under YouTube's Developer Policies (III.E.4.h)? → A: No. The owner's position is that a draft is new content for the user's own upload, not a metric and not a replacement for YouTube's data. That position is stated in the spec, disclosed in the privacy policy, and described in the YouTube audit application.
- Q: Can YouTube API data appear in model-call traces? → A: Superseded by the 2026-10-24 decision: keep text traces and accept the storage risk, with deployment blocked until the YouTube request is approved.
- Q: The pick now receives up to 10 separate candidate lists (#20). Does the latency target still hold? → A: It must. The pick is re-timed at that prompt size before the pick changes are built.

### Session 2026-10-24

- Q: What happens when someone makes a Short from a job analyzed before the swap (29.5 s windows), now that the hook position uses 60 s windows? → A: Refuse it. A job whose stored chunk count doesn't match its duration at 60 s windows takes the existing "new upload required" path. No schema change.
- Q: Is Gemini on Vertex AI a zero-retention fallback if Google's 55-day abuse log counts against YouTube's 30-day limit? → A: No, so the fallback is dropped. Without a Master Agreement, Vertex logs Gemini prompts for up to 90 days. Its only 30-day "Frontier" model is an allowlisted cybersecurity variant of Argon.
- Q: Keep the per-agent sizes-only tracing design? → A: No. Keep text traces for every agent and accept their storage risk. Prefer shorter hosted Sentry retention if available; do not add app retention machinery. Nothing in this feature is deployed until YouTube approves the request covering the disclosed processing and storage.
- Q: Do the YouTube audit docs change with the swap? → A: Yes. `docs/youtube-audit/` is updated in the same change as the code. The audit application is updated separately, on the owner's timing.
- Q: What actually restarts a job that's mid-analysis at deploy? The plan has no mechanism. → A: The analyze step itself. A stored chunk count that doesn't match the duration at 60 s windows clears the chunks and moves the job to prep. It's the same check as the old-job Short rule, with no migration.
- Q: Does the privacy page need more than the 55-day log for unreleased music? → A: Yes. It also says authorized Google staff may review flagged prompts, and that a deletion request can't reach Google's abuse-monitoring copy.
- Q: Simplify the review additions? → A: Yes. No durable brand quota state (the brand page stops polling on the wait), no request-body size check beyond the clip's 8 MB limit, and chunk counts keep skipping a sub-second tail.
- Q: Is Flash good enough to hear the music? G1 only used a synthetic video. → A: Unproven. Gate G2 runs Flash (planned settings), Flash (default settings) and Argon on a few of Nathan's real videos, scored against today's Gemma output. The analyst is built only after it passes.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - A job reaches review with no GPU running (Priority: P1)

Nathan uploads a video and types the song title. The status page runs prep, one analyze step per window, and the pick, exactly as today. "What the model heard" fills in per window. He lands on review with a title, description, hashtags and tags drawn from the same candidate lists and in the same voice.

**Why this priority**: This is the product. Everything else is cleanup around it.

**Independent Test**: Run a 3-minute and a 15-minute video end to end on the deployed app with the Vertex endpoint deleted. Both reach review; every hashtag and tag is in the job's candidate lists; no model-emitted loudness number appears.

**Acceptance Scenarios**:

1. **Given** a prepared job, **When** an analyze step starts, **Then** only that window is read from storage, cut into a small clip and sent to the model. The whole video is never loaded or re-uploaded.
2. **Given** a prepared job, **When** each analyze step runs, **Then** the model receives one window of the video (its pictures and sound) plus that window's ffmpeg measurements, the song title and notes, and returns visual, music and quality flags in today's shape.
3. **Given** a 15-minute video, **When** the page drives the run, **Then** every step returns within about 2 minutes and the page shows chunk N/M throughout.
4. **Given** the analyses, **When** the pick runs, **Then** it produces one title, description, hashtags, tags and Bandcamp copy under every existing R4 rule.
5. **Given** an analyst reply that fails to parse, **When** the step budget allows, **Then** it retries once, then stores numerics-stripped raw text on the chunk; other agents follow FR-008.

---

### User Story 2 - The model provider is busy or rate-limited (Priority: P1)

When the provider answers "too many requests" or "overloaded", the step returns at once with a plain wait and the page calls again. The job never fails for it.

**Why this priority**: The old "waking model" and "waiting on another run" waits go away with the GPU. Without a replacement wait, a provider blip fails the job.

**Independent Test**: Force a rate-limit response at the provider boundary during analyze and during pick. The page shows the wait, keeps calling, and the job continues once the provider answers.

**Acceptance Scenarios**:

1. **Given** the provider rate-limits a call, **When** the step runs, **Then** it returns the "model busy" wait, keeps finished work, and doesn't count a failure.
2. **Given** the provider is overloaded, **When** the step runs, **Then** it behaves as in scenario 1.
3. **Given** the provider rejects a request as invalid or unauthorized, **When** the step runs, **Then** it counts as a failure, as any other error does today.
4. **Given** two consecutive real failures on a chunk, **When** the second lands, **Then** the job is `FAILED` and retry resumes at that chunk, as today.

---

### User Story 3 - Shorts and the brand guide run on the new models (Priority: P2)

Hook pick and the brand-guide proposal produce the same outputs as today on the pick model. Cut placement and rendering stay with ffmpeg.

**Why this priority**: They share the model client; once picks work, these are the same change.

**Independent Test**: Make a Short from a reviewed job and propose a brand guide as the artist-linked user. Both complete; re-pick avoids skipped hooks.

**Acceptance Scenarios**:

1. **Given** a reviewed video, **When** Nathan makes a Short, **Then** the hook pick returns a window, length and reason from the chunk results and per-window loudness.
2. **Given** the artist-linked user, **When** they propose a brand guide, **Then** it reads the same uploads and thumbnails and returns a statement with keep / fix / drop rules.

---

### User Story 4 - Nothing of the GPU deployment remains (Priority: P2)

Deploys create no model endpoint and build no model image. The old endpoint, deployed model and image are deleted, so the GPU bill goes to zero.

**Why this priority**: Dropping the GPU bill is the reason for the change.

**Independent Test**: After deploy, list Vertex endpoints and models in the project: none for Soundboard. The deploy script has no model-endpoint step.

**Acceptance Scenarios**:

1. **Given** a fresh deploy, **When** it finishes, **Then** no model endpoint or model image was created.
2. **Given** the existing endpoint, **When** teardown runs once, **Then** the endpoint, its deployed model and the model image are gone.

---

### Edge Cases

- A video right at the 2 GB upload cap: each step seeks to its window without buffering the source; seek/decode time still depends on the source and is bounded by the shared deadline. A larger file is refused at upload (R1).
- The source object hit the 7-day delete rule: the job follows the existing "missing media, new upload required" path.
- A provider safety block or empty reply: one parse re-ask while budget allows; afterward the analyst stores raw text (possibly empty), pick/hook fail the step, and brand returns a retryable error (FR-008).
- The last window is shorter than the window length: the model sees only what remains, as today.
- A Short requested from a job analyzed before the swap (29.5 s windows): its chunk count doesn't match its duration at 60 s windows, so it takes the "new upload required" path instead of placing the hook in the wrong window.
- A job mid-analysis at deploy (29.5 s chunk count): its next analyze step atomically clears its chunks, resets its index and failure state, and returns it to prep under the matching claim; a lost claim or concurrent discard changes nothing. Prep recomputes the count.
- A provider price change: model names are configuration, so moving the analyst to the Lite model needs no code change.
- A pick with all 10 candidate lists full plus 5 example videos: it still meets the pick latency target, or the plan lowers its thinking level before raising any budget.
- A failed call: tracing never replaces the thrown error or strips its control-flow fields; media, credentials and signed-URL queries remain excluded from captured events.

- An oversized clip or expired deadline: no provider call starts, the temp file is removed, and the existing failure/retry path applies without saving a partial chunk.
- A Short already in `HOOK`, including a retry or re-pick, checks its parent before a model call; incompatible windows require a new upload. An existing absolute cut may finish `RENDER`, review and publishing, and may be re-cut without a new hook pick.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Every model call MUST go through one shared server-side client built on a provider-agnostic SDK, so changing a model or provider touches only that client and configuration. No browser code MUST reach the provider.
- **FR-002**: The app MUST use only a paid-tier Gemini project, so content is not used to improve Google's products.
- **FR-003**: Each analyze step MUST cut its window into a bounded 360p clip and send it inline. The encoder's bitrate cap keeps a 60 s clip near 5 MB, and the clip MUST be at most 8,000,000 bytes before it's read into memory, keeping the request under the provider's 20 MB inline limit. Oversize input MUST fail before a provider call, without silently shortening the window. The whole source MUST never be loaded into app memory; the temporary file MUST be deleted on success, rejection and timeout.
- **FR-004**: Each analyze step MUST send one window of the stored video, sound included, plus that window's ffmpeg measurements, song title and notes, and MUST return today's chunk analysis shape.
- **FR-005**: The app MUST NOT extract still frames or separate audio for the model; the model gets the window as one video clip with its sound. ffmpeg keeps prep probing, whole-file and per-window measurements, the window clip, Short cut placement and render.
- **FR-006**: Each step MUST stay under about 2 minutes, with one 110-second deadline shared by media work, model calls, retries and finalization. Windows MUST be 60 s long (the last one shorter); a 15-minute video is 15 windows. Media and provider work MUST be cancelled within that budget, reserving time for cleanup and persistence.
- **FR-007**: The analyst model and the pick model MUST each be set by configuration. Defaults: `gemini-3.8-flash` for the analyst; `gemini-4-argon` for smart pick, hook pick and brand guide.
- **FR-008**: Every model reply MUST be schema-constrained JSON, validated in code and retried once on parse failure while budget allows. After exhaustion, the analyst MUST store numerics-stripped raw text on its chunk and continue. Smart pick and hook pick MUST fail through the existing two-strike step path; brand MUST return its existing retryable error. Their raw replies remain diagnostic trace data, not new database records or publishable output. Empty and blocked replies follow the same rules.
- **FR-009**: Provider rate-limit and overload responses MUST return a "model busy" wait at once, keep finished work, and MUST NOT count as a failure. A spent daily quota MUST return its own wait that resumes after the quota resets, without calling the provider until then. Other provider errors MUST count as failures.
- **FR-010**: The "waking model" and "waiting on another run" waits, the readiness and slot checks, and the endpoint URL setting MUST be removed with their code, config and tests.
- **FR-011**: All existing output rules MUST hold unchanged: numbers only from ffmpeg with model numerics stripped, hashtags and tags only from the job's candidates, the artist voice, the server-built flags, and verified-by-read-back.
- **FR-012**: Sentry spans MUST name the provider and the actual model of each call. Image parts MUST be recorded as `{type, mime, bytes}` and video parts as `{type, mime, bytes, clip}` placeholders, never their content.
- **FR-013**: The job page and Short tab MUST label current configuration as `Configured analyst: <model>` or `Configured picker: <model>`, with total model time displayed separately. This MUST NOT claim which model generated historical results; per-call traces retain that evidence. No provenance migration is required.
- **FR-014**: Deploys MUST NOT create a model endpoint or build a model image. A one-time teardown MUST delete the existing endpoint, deployed model and model image.
- **FR-015**: Provider behavior the docs leave open MUST be proven by a recorded manual gate before dependent code is built. Gate G1 ran on 2026-10-22: clip handling, token scaling, latency and Argon timing are recorded in research R12.
- **FR-016**: The PRD, README, AGENTS.md, the public privacy page, the constitution and the YouTube audit docs (`docs/youtube-audit/architecture.md`, `user-flows.md`) MUST be updated to match: the provider and model lines, the "audio stays in the project" line, the third-party-inference non-goal, System Design and cost, call settings, wait names, the model label, the mock boundary, and the audit docs' model provider, data flow and trace handling. The audit application itself is updated separately, outside this spec.

- **FR-017**: All agents MUST use the same text-tracing policy: prompts, replies, reasoning and re-ask turns remain available for debugging, including YouTube-derived text. Media bytes, secrets and signed-URL credential queries MUST remain redacted. No per-agent text switch or replacement of thrown errors for tracing is required. The owner accepts third-party storage risk; shorter hosted Sentry retention is an operational preference, not custom app logic. Deployment remains blocked by FR-023.
- **FR-018**: The public privacy page MUST name paid-tier Gemini as processor of video clips and YouTube metadata, and Sentry as processor of text traces. It MUST distinguish `store: false` interaction storage, automatic implicit caching and the up-to-55-day abuse log, without claiming zero retention or an unestablished cache expiry. It MUST disclose possible human review, deletion limits, actual Sentry retention, and that content is not used to improve Google products; policy-enforcement model use remains covered by the abuse-monitoring terms.
- **FR-019**: The app MUST use `store: false` and MUST NOT request explicit caching, file uploads or grounding. Implicit caching, abuse logs and Sentry text retention are accepted storage risks subject to FR-023; the abuse log MUST NOT be described as the only provider copy. Existing database research expiry and daily cleanup remain unchanged. Drafts MUST be new content for the requesting user's own upload, never metrics, scores or replacements for YouTube data (III.E.4.h, per the owner's stated interpretation).
- **FR-020**: The artist's own authorized channel data (recent videos, thumbnails) MUST be sent to the model only for that artist's own request, and MUST never be shown to another user (III.E.3.b).
- **FR-021**: The smart pick MUST meet its latency target with the full prompt from #20: up to 10 separate candidate lists plus 5 example videos.
- **FR-022**: Before the analyst is built, gate G2 MUST record a comparison on 3–5 of Nathan's real videos covering three configurations: Flash at the planned low media resolution and low thinking, Flash at default resolution and medium thinking, and Argon. Each is scored per window against today's Gemma analysis of the same videos for genre terms, instruments, vocals and quality flags. The analyst ships on the cheapest configuration that's at least as good as Gemma. If none is, the spec reopens.

- **FR-023**: This feature MUST NOT be deployed, including for hosted validation, until the owner records YouTube's approval of the request covering the disclosed Gemini processing/storage and Sentry text retention. Local design and implementation may proceed; G2 still blocks analyst implementation. Submission, silence, owner risk acceptance or shorter Sentry retention alone MUST NOT satisfy this gate. A contrary or narrower approval reopens the affected design before deployment.

### Key Entities

- **Job**: unchanged database schema. The app stores no provider interaction IDs; each clip is temporary. Chunks keep today's shape, one per 60 s window; incompatible partial analysis is reset atomically.
- **Model setting**: two configured model names, analyst and picker. G2 (FR-022) can change the analyst's default model, media resolution and thinking level.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: The project's GPU spend for Soundboard is $0 in the first full billing week after teardown.
- **SC-002**: A warm 30-second video goes from upload to recommendation in 2 minutes or less (unchanged PRD target).
- **SC-003**: A 15-minute video completes end to end with every step under about 2 minutes.
- **SC-004**: 100% of hashtags and tags in picks come from the job's candidate lists across the regression suite.
- **SC-005**: A forced rate-limit during analyze or pick fails 0 jobs.
- **SC-006**: Typical model cost for a 15-minute job (the upload cap) stays under $0.50 at the post-increase prices. The worst case (full thinking budgets plus every re-ask) is stated in research R6, not capped.
- **SC-007**: No Sentry event contains media bytes, credentials or signed-URL credential queries; all agents retain text diagnostics, and typed waits and parse retries still behave correctly.
- **SC-008**: The live privacy page names the Gemini API as a processor of video clips and YouTube metadata on the day the swap ships.
- **SC-009**: Smart pick p95 stays at or under 45 s with a full-size prompt (10 candidate lists, 5 example videos).

- **SC-010**: Before any deployment, the owner has recorded the approval reference and scope, actual Sentry retention and any restrictions in the release evidence.

## Evidence Boundary

- Automated tests mock the provider at its HTTP boundary. The FR-015 gate and the deployed end-to-end runs supply real provider evidence.

## Assumptions

- Ashley owns the decision that Nathan's audio now leaves the GCP project for the Gemini API under paid-tier terms.
- Thumbnails for smart pick and the brand guide keep going inline as small images.
- Temperature and thinking level follow Gemini's guidance per agent, chosen in planning; today's 0.2 isn't kept by default.
- Argon's intro price doubles on 2026-12-01 and Flash's on 2027-01-01. SC-006 uses the higher prices.
- E2E keeps no live model: model steps end at a faked provider wait, as they end at "waking model" today.
- Pre-beta: no migration of in-flight jobs. A job mid-analysis at deploy restarts from prep automatically (Edge Cases). A job already past analysis keeps its review; a new hook pick from incompatible analysis needs a new upload, while existing absolute Short cuts remain usable (Edge Cases).
- Google retains prompts and responses for up to 55 days for abuse monitoring and also uses implicit caching on stateless calls. The owner accepts that storage risk; FR-023 gates deployment on approval of the disclosed use, without asserting a 30-day provider-retention guarantee.
- The owner's interpretation of III.E.4.h (drafts are new content, not derived data) is a stated position, not a YouTube ruling. The audit application describes it, and an audit answer that contradicts it reopens this spec.
- Genre-search evidence storage (the `job_audience` table, the fresh-evidence view and the daily cleanup) shipped in #20 and is unchanged here.

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
5. **Given** a model reply that fails to parse, **When** the step budget allows, **Then** it retries once, then keeps the raw text, as today.

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

- A video right at the 2 GB upload cap: each step still reads only its own window, so call time doesn't grow with file size. A larger file is already refused at upload (R1).
- The source object hit the 7-day delete rule: the job follows the existing "missing media, new upload required" path.
- A provider safety block or empty reply: treated like a parse failure (retry once, keep raw text).
- The last window is shorter than the window length: the model sees only what remains, as today.
- A provider price change: model names are configuration, so moving the analyst to the Lite model needs no code change.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Every model call MUST go through one shared server-side client built on a provider-agnostic SDK, so changing a model or provider touches only that client and configuration. No browser code MUST reach the provider.
- **FR-002**: The app MUST use only a paid-tier Gemini project, so content is not used to improve Google's products.
- **FR-003**: Each analyze step MUST cut its window from the stored video into a small clip (360p, a few MB) and send it with the call. The whole video MUST never be loaded into app memory, and the clip's temporary file MUST be deleted when the step ends.
- **FR-004**: Each analyze step MUST send one window of the stored video, sound included, plus that window's ffmpeg measurements, song title and notes, and MUST return today's chunk analysis shape.
- **FR-005**: The app MUST NOT extract still frames or separate audio for the model; the model gets the window as one video clip with its sound. ffmpeg keeps prep probing, whole-file and per-window measurements, the window clip, Short cut placement and render.
- **FR-006**: Each step MUST stay under about 2 minutes. Windows MUST be 60 s long (the last one shorter); a 15-minute video is 15 windows.
- **FR-007**: The analyst model and the pick model MUST each be set by configuration. Defaults: `gemini-3.8-flash` for the analyst; `gemini-4-argon` for smart pick, hook pick and brand guide.
- **FR-008**: Every model reply MUST be schema-constrained JSON, validated in code, retried once on a parse failure while budget allows, then kept as raw text.
- **FR-009**: Provider rate-limit and overload responses MUST return a "model busy" wait at once, keep finished work, and MUST NOT count as a failure. A spent daily quota MUST return its own wait that resumes after the quota resets, without calling the provider until then. Other provider errors MUST count as failures.
- **FR-010**: The "waking model" and "waiting on another run" waits, the readiness and slot checks, and the endpoint URL setting MUST be removed with their code, config and tests.
- **FR-011**: All existing output rules MUST hold unchanged: numbers only from ffmpeg with model numerics stripped, hashtags and tags only from the job's candidates, the artist voice, the server-built flags, and verified-by-read-back.
- **FR-012**: Sentry spans MUST name the provider and the actual model of each call. Image parts MUST be recorded as `{type, mime, bytes}` and video parts as `{type, mime, bytes, clip}` placeholders, never their content.
- **FR-013**: The model label on the job page and the Short tab MUST name the model in use instead of `gemma-4-12b-it`, with the same total-model-time counter.
- **FR-014**: Deploys MUST NOT create a model endpoint or build a model image. A one-time teardown MUST delete the existing endpoint, deployed model and model image.
- **FR-015**: Provider behavior the docs leave open MUST be proven by a recorded manual gate before dependent code is built. Gate G1 ran on 2026-10-22: clip handling, token scaling, latency and Argon timing are recorded in research R12.
- **FR-016**: The PRD, README, AGENTS.md and the constitution MUST be updated to match: the provider and model lines, the "audio stays in the project" line, the third-party-inference non-goal, System Design and cost, call settings, wait names, the model label, and the mock boundary.

### Key Entities

- **Job**: unchanged. Nothing provider-side is stored; each window's clip is a temporary file deleted at the end of its step. Chunks keep today's shape, one per 60 s window.
- **Model setting**: two configured model names, analyst and picker.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: The project's GPU spend for Soundboard is $0 in the first full billing week after teardown.
- **SC-002**: A warm 30-second video goes from upload to recommendation in 2 minutes or less (unchanged PRD target).
- **SC-003**: A 15-minute video completes end to end with every step under about 2 minutes.
- **SC-004**: 100% of hashtags and tags in picks come from the job's candidate lists across the regression suite.
- **SC-005**: A forced rate-limit during analyze or pick fails 0 jobs.
- **SC-006**: Typical model cost for a 15-minute job (the upload cap) stays under $0.50 at the post-increase prices. The worst case (full thinking budgets plus every re-ask) is stated in research R6, not capped.
- **SC-007**: No Sentry event contains media bytes or a signed URL's credential query.

## Evidence Boundary

- Automated tests mock the provider at its HTTP boundary. The FR-015 gate and the deployed end-to-end runs supply real provider evidence.

## Assumptions

- Ashley owns the decision that Nathan's audio now leaves the GCP project for the Gemini API under paid-tier terms.
- Thumbnails for smart pick and the brand guide keep going inline as small images.
- Temperature and thinking level follow Gemini's guidance per agent, chosen in planning; today's 0.2 isn't kept by default.
- Argon's intro price doubles on 2026-12-01 and Flash's on 2027-01-01. SC-006 uses the higher prices.
- E2E keeps no live model: model steps end at a faked provider wait, as they end at "waking model" today.
- Pre-beta: no migration of in-flight jobs. A job mid-analysis at deploy restarts from prep.

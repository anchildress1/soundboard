# Feature Specification: Per-artist voice and brand guide

**Feature Branch**: `005-artist-branding`

**Created**: 2026-10-23

**Status**: Draft

**Input**: User description: "Create the spec for the artist branding." Today the writing voice is a fixed set of rules drawn from Nathan's writing, and the brand guide exists only for his profile. Every other artist's drafts come out sounding like Nathan.

## Clarifications

### Session 2026-10-23

- Q: What does artist branding cover? → A: A writing voice and a brand guide per artist. Visual identity (thumbnail style, colors) is out of scope.
- Q: Where does an artist's voice come from? → A: Two sources:
  - The artist's own YouTube video descriptions, read through their own connection when a proposal is made.
  - Their edits and approvals in Soundboard.
- Q: Is the voice used automatically? → A: No. Soundboard proposes a voice and a brand guide, and the artist edits and approves them. Until then, picks use generic voice rules.
- Build order: this depends on spec 004 (artist profile and connected channel). Spec 006 saves its peer-influence sliders with this brand guide, so 005 is built before 006.

## User Scenarios & Testing _(mandatory)_

### User Story 1: Propose and approve my voice (Priority: P1)

An artist opens their brand page and asks Soundboard to propose their voice. It reads their own recent video descriptions and their past edits in Soundboard. It shows a short set of voice rules: how they write, their recurring lines, what to avoid. They edit the rules and approve. From then on, their drafts follow that voice.

**Why this priority**: Drafts that don't sound like the artist get rewritten every time. This is what makes Soundboard usable for anyone other than Nathan.

**Independent Test**: As a non-Nathan artist with a connected channel, propose, edit and approve a voice, then run a pick. The description follows the approved rules, not Nathan's.

**Acceptance Scenarios**:

1. **Given** an artist with a connected channel, **When** they ask for a proposal, **Then** Soundboard shows voice rules based on their own descriptions and Soundboard edits, and names which sources it used.
2. **Given** a proposal, **When** the artist edits and approves it, **Then** it becomes their active voice, and the next pick uses it.
3. **Given** no approved voice, **When** a pick runs, **Then** it uses generic voice rules (short, plain, literal, no marketing copy) and never another artist's voice.
4. **Given** an artist with no connected channel and no edits yet, **When** they ask for a proposal, **Then** Soundboard says there's nothing to learn from yet and suggests connecting YouTube or running a few jobs. Nothing is proposed.

---

### User Story 2: Propose and approve my brand guide (Priority: P1)

The artist asks for a brand guide proposal. Soundboard reads their own recent uploads (titles, descriptions, a few tags, thumbnails) through their connection and proposes a brand statement with keep / fix / drop rules. The artist edits and approves it, and picks follow it.

**Why this priority**: Today only Nathan can do this. Every artist needs a consistent channel.

**Independent Test**: As a non-Nathan artist, propose, edit and approve a brand guide, then run a pick. It follows the approved rules.

**Acceptance Scenarios**:

1. **Given** a connected channel, **When** the artist asks for a brand guide proposal, **Then** it reads that artist's own uploads through their own grant and proposes a statement with keep / fix / drop rules.
2. **Given** a proposal, **When** it's approved, **Then** every later pick for that artist follows it.
3. **Given** another artist, **When** they open the brand page, **Then** they see only their own voice and brand guide.

---

### User Story 3: Nathan keeps what he has (Priority: P1)

Nathan's current voice rules and his approved brand guide become his approved profile, with no new approval needed. His next draft reads the same as before.

**Why this priority**: The first artist must not regress.

**Independent Test**: Compare a pick for Nathan made before and after the release. The voice and brand rules applied are the same.

**Acceptance Scenarios**:

1. **Given** Nathan's account, **When** this ships, **Then** his voice and brand guide show as already approved, with today's content.
2. **Given** Nathan, **When** he proposes a new voice later, **Then** it replaces his current one only after he approves it.

---

### User Story 4: The voice stays current (Priority: P2)

As the artist edits and approves drafts, Soundboard keeps those edits as voice evidence. The artist can ask for a fresh proposal at any time. The active voice changes only when they approve one.

**Why this priority**: Voices drift, but surprise changes erode trust.

**Independent Test**: Approve a voice, make several edits on drafts, then propose again. The new proposal reflects the edits, and the active voice is unchanged until it's approved.

**Acceptance Scenarios**:

1. **Given** an approved voice and new edits, **When** the artist proposes again, **Then** the proposal reflects the edits, and the active voice stays until approval.
2. **Given** a pending proposal, **When** the artist discards it, **Then** the active voice is unchanged.

### Edge Cases

- **Very little writing** (for example, a channel whose descriptions are only links): the proposal says its evidence is thin and keeps its rules few, rather than inventing a style.
- **Descriptions written by someone else** (a label or editor): the artist sees the proposal and the sources it used before approving, and can edit or discard it.
- **The connection is lost or revoked mid-proposal:** the proposal stops with a reconnect message. Approved rules are untouched.
- **An approved voice that conflicts with the app's content rules** (for example "always add 20 hashtags"): content rules win. Candidate-only tags, no model-made numbers, and YouTube length limits still apply.
- **The artist's own surname, or Nathan's,** in their descriptions: the app never filters it from runtime data, never adds it to code, and the artist decides what stays in the approved rules.
- **Proposals and approvals racing in two tabs:** the latest approval wins, and the losing tab is told the guide changed.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Each artist profile (spec 004) MUST have its own voice and its own brand guide, each with at most one pending proposal and at most one approved version.
- **FR-002**: A voice proposal MUST be built from the artist's own YouTube video descriptions and their edits and approvals in Soundboard. A brand guide proposal MUST be built from their own recent uploads (titles, descriptions, a few tags, thumbnails). Both MUST say which sources they used.
- **FR-003**: YouTube data for a proposal MUST be read only through the artist's own connection and grant, and only at proposal time. Comments MUST NOT be read.
- **FR-004**: The YouTube data used for a proposal MUST NOT be kept past 30 days. Only the artist-approved rules are kept, as the artist's own statement (per the owner's stated interpretation of YouTube Developer Policies III.E.4.h, as in spec 002). No YouTube statistics MUST be stored.
- **FR-005**: The artist MUST be able to edit, approve or discard a proposal. Only an approved voice or brand guide MUST affect picks.
- **FR-006**: Without an approved voice, picks MUST use generic voice rules, never another artist's voice. Without an approved brand guide, picks MUST run without one.
- **FR-007**: Every pick, re-run, hook pick and Short draft MUST use the owner's approved voice and brand guide, and no other artist's.
- **FR-008**: Content rules MUST outrank the voice and brand guide: candidate-only tags and hashtags, ffmpeg-only numbers, YouTube length limits, and never-invented facts.
- **FR-009**: Nathan's current voice rules and approved brand guide MUST carry over as his approved versions, unchanged, with no action from him.
- **FR-010**: The brand page MUST be available to every artist and show only their own voice and brand guide. Another user's MUST be not-found.
- **FR-011**: Approving a new voice or brand guide MUST NOT change already approved or published job fields.
- **FR-012**: The approved brand guide MUST be where spec 006 saves the artist's peer-influence slider settings.
- **FR-013**: The PRD (R4 voice, R12 brand guide), AGENTS.md (the `ARTIST_VOICE` rule) and the constitution's voice rule MUST be updated to say voice comes from each artist's approved voice.

### Key Entities

- **Voice**: per artist. Short writing rules (tone, sentence shape, recurring lines, things to avoid). It has a pending proposal and an approved version, each listing its sources.
- **Brand guide**: per artist. A statement plus keep / fix / drop rules, with a pending proposal and an approved version. The approved version also holds spec 006's slider settings.
- **Voice evidence**: the artist's edits and approvals in Soundboard. Kept as today's artist feedback; nothing new from YouTube is stored.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: An artist with a connected channel goes from "propose" to an approved voice and brand guide in under 5 minutes.
- **SC-002**: For non-Nathan artists, 0 drafts follow Nathan's voice rules once their own are approved, and 0 follow any other artist's.
- **SC-003**: Nathan's first draft after release applies the same voice and brand rules as before.
- **SC-004**: No YouTube data used for a proposal is retained past 30 days, and no YouTube statistics are stored.
- **SC-005**: In a blind comparison, the artist prefers their approved-voice draft over a generic-voice draft for at least 3 of 4 songs.
- **SC-006**: Approving a new voice changes 0 approved or published jobs.

## Assumptions

- Spec 004 is in place: every user has an artist profile and a connected channel, or none.
- Generic voice rules mean short, plain, literal text with no marketing copy, the same baseline Nathan's rules started from.
- Thumbnails go to the model only for brand proposals, as today.
- How many descriptions and edits a proposal reads is a planning decision, bounded by the model's context and the step budget.
- Proposals run as a page-driven step while the artist waits, like today's brand proposal. No background work is added.
- The owner's interpretation that approved rules are the artist's own statement, not derived data, is a stated position. The YouTube audit application describes it.

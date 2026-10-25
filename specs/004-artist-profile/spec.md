# Feature Specification: Artist profile inputs and display

**Feature Branch**: `004-artist-profile`

**Created**: 2026-10-23

**Status**: Draft

**Input**: User description: "We still need a spec for artist name inputs and display." Today every artist detail is hard-coded to Flies Like Robots. That covers:

- the forced artist tag and the name in prompts
- the contact line in drafts
- the channel that identity and brand reads come from
- the Bandcamp editor and footer links
- the header and the page description
- the seeded artist-name fact

## Clarifications

### Session 2026-10-23

- Q: How do users relate to artists? → A: One artist per user. Each signed-in user owns exactly one artist profile, and Nathan's account keeps the existing Flies Like Robots profile. Profiles are never shared between accounts.
- Q: Which details does the user enter? → A: Artist name (required), Bandcamp URL (optional) and contact line (optional). The channel isn't typed: identity and brand reads use the user's connected YouTube channel.
- Q: When is the name entered? → A: After first sign-in, a short form asks for it before the first job can start. Everything stays editable later on the Settings page (`/settings`).
- Q: Does this include per-artist voice and brand? → A: No. This covers identity inputs and where they show. Learning each artist's voice is a separate future spec: other artists get generic voice rules, and Nathan keeps his.

### Session 2026-10-25

- Q: What happens when the YouTube grant is missing or revoked at pick time? → A: The pick waits with "Reconnect YouTube" (constitution III). It never runs without identity.
- Q: How is Nathan's voice and brand guide selected? → A: A migration-only `curated` flag on his profile. Spec 005 deletes it.
- Q: Which Bandcamp addresses are accepted? → A: Only `https://<name>.bandcamp.com`, the form gate G1 verified.
- Q: Which artist names are refused besides length and `<`/`>`? → A: Names with a comma, and names starting with `#`. The required artist tag is exempt from the song-title rule and can't be removed in the tag editor.
- Q: Do non-Nathan drafts carry a credit line? → A: Never. Only Nathan's curated profile gets his credit line.
- Q: Which name does a Short use? → A: The owner's current profile name when the Short is created.
- Q: What happens to a pick on an older job whose owner has no profile yet? → A: It waits with "Add your artist name first." and a link to Settings.
- Q: Can a contact line contain `#`? → A: No. The app appends it verbatim, and a hashtag outside the job's list would block approval.
- Q: Which job does a Short belong to for artist memory? → A: The parent's artist link. Only its tags use the owner's current name.
- Q: What if KMS can't decrypt a stored YouTube grant under its key? → A: Treat it as access-lost, like a revoked grant: mark the connection revoked and wait on "Reconnect YouTube", with no failure strike, for identity reads, the pick, the brand guide, upload and verify. KMS transport or permission errors still fail as before.

## User Scenarios & Testing _(mandatory)_

### User Story 1: Tell Soundboard who the artist is (Priority: P1)

A newly invited user signs in for the first time. Before they can start a run, a short form asks for their artist name, with optional Bandcamp and contact fields. They save it and land on the home page.

**Why this priority**: Without it, every user's drafts carry Flies Like Robots' name and links.

**Independent Test**: Sign in as a new invited user. The form appears before a release can start on `/new`. Save a name, and the header shows it.

**Acceptance Scenarios**:

1. **Given** a signed-in user with no artist profile, **When** they open `/new`, **Then** they see the artist form instead of the new-release form.
2. **Given** the form, **When** they submit an empty name, **Then** it's refused with a plain message and nothing is saved.
3. **Given** a valid name, **When** they save, **Then** their artist profile exists and the new-release form appears.
4. **Given** a user with no artist profile, **When** they try to start a job any other way, **Then** it's refused with "Add your artist name first."
5. **Given** Nathan's account, **When** this feature ships, **Then** it already has the Flies Like Robots profile, with the same name, Bandcamp URL and contact line as today, and he never sees the form.

---

### User Story 2: Drafts use the user's own artist details (Priority: P1)

The user runs a job. The draft's forced artist tag, the artist name in the prompts, the Bandcamp credits and the contact line all come from their own profile. Identity reads use their own connected channel.

**Why this priority**: This is the point of the feature. A draft with another band's name or contact is unusable.

**Independent Test**: As a non-Nathan user, run a job to review. The tags include their artist name, not Flies Like Robots. The description and Bandcamp copy use their contact line or none. No Flies Like Robots value appears anywhere in the draft.

**Acceptance Scenarios**:

1. **Given** an artist profile, **When** a pick runs, **Then** the artist name is the required tag and the name used in the prompt.
2. **Given** a contact line, **When** a draft is written, **Then** it uses that line. **Given** no contact line, **Then** the draft has no contact line.
3. **Given** a connected YouTube channel, **When** the pick reads the artist's recent uploads for identity, **Then** it reads that user's own channel through that user's own grant.
4. **Given** a disconnected, missing or revoked YouTube grant, **When** a pick runs, **Then** it waits with "Reconnect YouTube" and makes no model call. It never runs without identity, and it never falls back to another artist's channel.

---

### User Story 3: The app shows the user's artist (Priority: P2)

Signed in, the user sees their own artist name in the header. The Bandcamp screen opens their own Bandcamp editor. The footer credits their artist.

**Why this priority**: Display mistakes are visible on every page, but they don't break a draft.

**Independent Test**: Signed in as a non-Nathan user, check the header, the Bandcamp screen and the footer: no Flies Like Robots value appears. Signed out, the shared pages show no user's artist.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** any page loads, **Then** the header shows their artist name.
2. **Given** a Bandcamp URL, **When** the Bandcamp screen opens the editor, **Then** it opens that artist's Bandcamp editor. **Given** no Bandcamp URL, **Then** the screen still offers the copy and shows "Add your Bandcamp URL in Settings" instead of an editor link.
3. **Given** a signed-in user, **When** the footer renders, **Then** it credits their artist, linked to their Bandcamp page when they have one.
4. **Given** a signed-out visitor, **When** the sign-in page or `/privacy` renders, **Then** neither the header nor the footer names any user's artist.

---

### User Story 4: Change artist details later (Priority: P2)

On the Settings page, the user edits their artist name, Bandcamp URL or contact line. New drafts use the new values. Drafts already approved keep what was approved.

**Why this priority**: Bands rename, and links change.

**Independent Test**: Change the name, then start a new job and re-run an old one. The new pick uses the new name, and an already-approved job's fields don't change.

**Acceptance Scenarios**:

1. **Given** the Settings page, **When** the user saves a new name, **Then** the next pick and re-run use it.
2. **Given** an approved or published job, **When** the name changes, **Then** that job's approved fields stay as they were.
3. **Given** an invalid value (empty name, malformed URL), **When** saving, **Then** it's refused with a plain message and the old value stays.

### Edge Cases

- **A name that can't survive as one tag** (too long, containing `<`, `>` or a comma, or starting with `#`): it's refused at entry with the reason. A comma would split it into two tags in the editor, and a leading `#` reads as a hashtag. The forced tag can never break the 500-character tags limit.
- **A name that contains the song title** (a self-titled song): the required artist tag is exempt from the song-title rule.
- **A name matching one of the song's tag candidates:** it's still added once, never duplicated.
- **Two users entering the same artist name:** allowed. Profiles are per account, not unique names.
- **A Bandcamp URL that isn't `https://<name>.bandcamp.com`:** refused, custom domains included.
- **A contact line containing a link:** allowed as the user wrote it. It's their own contact, placed by the app, not rewritten by the model.
- **A cleared contact line:** the next draft has none, even if older uploads or feedback carry one.
- **A contact line with `#`:** refused at entry. It would read as a hashtag outside the job's list.
- **Contact text the model copies** (an old email, phone number, link, `@handle` or a "Booking:" line): removed by pattern before the app appends the current line. Forms outside those patterns are caught at Review.
- **A user who signed in before this feature and has no profile:** they see the form on their next visit before starting a job. Their existing jobs stay readable.
- **The connected channel changes:** identity reads follow the current connection. Jobs already approved keep their recorded destination channel (spec 001).
- **Nathan's surname:** never pre-filled or written anywhere by the app. His profile name stays "Flies Like Robots".

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Each signed-in user MUST have at most one artist profile, owned by that account and never shared.
- **FR-002**: An artist profile MUST hold a required artist name, an optional Bandcamp URL and an optional contact line.
- **FR-003**: A user without an artist profile MUST see the artist form before the new-release form, and MUST NOT be able to start a job until a profile is saved.
- **FR-004**: The artist name MUST be trimmed and 1–100 characters, MUST NOT contain `<`, `>` or `,`, and MUST NOT start with `#`. The Bandcamp URL MUST be `https://<name>.bandcamp.com`, with no path, port or credentials. The contact line MUST be at most 200 characters and MUST NOT contain `<`, `>` or `#`.
- **FR-005**: Every pick, re-run and Short MUST carry the job owner's artist name as the required tag, exactly once. Every model prompt that names the artist MUST use that name; the hook prompt names no artist. A Short MUST use the owner's current name at Short creation. The required artist tag MUST be exempt from the song-title rule and MUST NOT be removable in the tag editor.
- **FR-006**: Drafts (description and Bandcamp credits) MUST end with the owner's current contact line exactly when set, and contain no contact line when it isn't. The app places it; the model doesn't write it.
- **FR-007**: Identity reads (recent uploads) and brand-guide reads MUST use the owner's connected YouTube channel through the owner's own grant. A missing, disconnected or revoked grant MUST make the pick wait with "Reconnect YouTube" before any model call (constitution III). The app MUST never read another artist's channel instead.
- **FR-008**: The Bandcamp screen MUST link to the owner's Bandcamp editor when a Bandcamp URL is set, and show an "add it in Settings" note when it isn't.
- **FR-009**: When signed in, the header MUST show the user's artist name, and the footer MUST credit the user's artist, linked to their Bandcamp page when set. When signed out, neither MUST name any user's artist.
- **FR-010**: The page description shared with link previews MUST describe the product generically, never a specific artist.
- **FR-011**: The Settings page MUST let the user edit all three fields. Changes MUST apply to later picks only. Approved and published fields MUST NOT change.
- **FR-012**: Nathan's account MUST keep the existing Flies Like Robots profile, with today's name, Bandcamp URL and contact line, without seeing the form.
- **FR-013**: No Flies Like Robots value MUST remain hard-coded in app code, prompts, links or page text. The only exceptions are Nathan's own voice rules and his profile's seeded facts.
- **FR-014**: The artist-name fact in artist memory MUST come from the profile, not a constant.
- **FR-015**: This feature MUST NOT store any YouTube statistics. Channel identity MUST come only through the owner's own grant (YouTube Developer Policies III.E.3.b, and the constitution's Platform Terms).
- **FR-016**: The PRD (R4 identity, R8–R10, UX) and AGENTS.md MUST be updated to match.

### Key Entities

- **Artist profile**: one per user. Holds the artist name, Bandcamp URL and contact line, plus the existing artist-memory link. It replaces today's operator-assigned `flr` link, and Nathan's profile keeps that ID.
- **User**: unchanged, except that an artist profile becomes required before starting a job.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A new invited user goes from first sign-in to a saved artist profile in under 1 minute.
- **SC-002**: For a non-Nathan user, 0 occurrences of a Flies Like Robots value (name, links, contact) appear in their drafts, header, footer or Bandcamp screen across the regression suite.
- **SC-003**: 100% of picks include the owner's artist name as a tag, exactly once.
- **SC-004**: Nathan's next draft after the release is identical in artist name, links and contact line to one made before it.
- **SC-005**: Changing an artist name changes 0 approved or published jobs.
- **SC-006**: A signed-out page names 0 users' artists.

## Assumptions

- **Voice:** learning each artist's voice is a separate spec. Until then, non-Nathan artists get generic voice rules (short, literal, no marketing copy), and Nathan keeps `ARTIST_VOICE`.
- **Brand guide:** stays limited to Nathan's profile in this spec. Its channel read moves to his connected channel, which is the same channel as today.
- **Artist memory:** every user now has a profile, so artist memory and feedback (spec 001's artist gating) apply to every user's own artist, keyed by their profile. Profiles are never shared.
- **Footer credit:** the signed-out footer drops the Flies Like Robots credit and keeps only Ashley's credit, the privacy link and the social links.
- **Recent uploads:** identity reads are used only inside the step that reads them. They're never stored in the database, and YouTube-sourced text is replaced with a placeholder in traces.
- **Credit line:** only Nathan's curated profile gets a credit line. Other artists' drafts carry none.
- **Dependencies:** sign-in and Connections from spec 001. Nothing from specs 002, 003, 005 or 006 is required.

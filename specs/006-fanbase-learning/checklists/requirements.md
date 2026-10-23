# Specification Quality Checklist: Learn what grows the fanbase

**Purpose**: Validate specification quality before planning

**Created**: 2026-10-22

**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No unresolved clarification markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic
- [x] Acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions are identified

## Feature Readiness

- [x] Functional requirements have consistent acceptance criteria
- [x] User scenarios cover primary flows
- [x] Success criteria test learning without promising growth
- [x] No implementation design leaks into the specification

## Notes

- Removed unrequested research caps, cache intervals, fixed observation windows, assessment-state design, and deployment/governance instructions.
- Preserved the roles, performance brackets, free-source constraint, pipeline execution, and separate dashboard scope.
- The artist is the signed-in user; draft roles do not introduce separate account permissions.
- Resolved: the artist saves sliding-scale defaults for every role, including wording and feel; generation and its checks honor those settings.
- Acceptance covers slider endpoints, an intermediate setting, persistence, unavailable evidence, and unchanged facts and approved drafts.
- Peer selection always prefers the bracket above the artist, and recommendations imitate what works there. Same-bracket peers serve only as a baseline or a stated fallback. Two-up peers are labeled secondary evidence, weighted lower and never alone the basis for the main hypothesis.
- Re-review fixes 2026-10-22: Supersedes now lists constitution II, ARTIST_VOICE and PRD R4. The cross-channel ban is unconditional. The allowance assumption is limited to simple arithmetic. Calculated numbers are labeled. Stored citations drop peer stats after 30 days. Strongest wording and feel cite ≥2 peers. Match basis is an FR. FRs renumbered in order.
- Ready for planning; checked items describe specification quality, not implemented behavior.
- Learning retains promising patterns without claiming individual tactics caused growth; acceptance includes a successful release with multiple changed factors.
- Brackets use subscriber-count ranges; views and engagement remain separate evidence using simple calculations, with no combined score. Expanded storage and custom models are deferred for this single-user POC.
- Applied the 2026-10-22 adversarial review:
  - YouTube policy limits: 30-day peer stats, individual examples, and authorization rechecks. Simple calculations rely on the assumed III.L allowance.
  - Artist vs peer metrics (fans vs reach), and optional analytics consent.
  - Several-peer pooling at the strongest wording and feel setting.
  - Supersedes and amendment prerequisites.
  - Peer releases replace the genre search's top videos, and peers record their match basis.
  - Attribution edge cases.
  - Slider checks made observable through cited sources.
  - The existing R4 storage conflict, tracked in TTD.
- Added the user's peer rule: exclude labels, compilations, and multi-artist curators, and skip uncertain matches.

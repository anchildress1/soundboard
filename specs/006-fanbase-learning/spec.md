# Feature Specification: Learn what grows the fanbase

**Feature Branch**: 006-fanbase-learning

**Created**: 2026-10-22

**Status**: Planned — revised 2026-10-25

**Input**: Grow the artist's fanbase by combining what worked for them with what works for similar artists, testing recommendations, and learning from the results.

**Vision**: Increase the artist's popularity on social media without making them sound like someone else. This feature starts with YouTube.

## Clarifications

### Session 2026-10-22

- Use free data sources only; Gemini is the approved paid model.
- Research and learning happen during a pipeline run, not on page visits.
- The analytics dashboard is a separate future feature.
- Spec 004 remains reserved for band input.
- Peers share the artist's sound and genre. The bracket above the artist is always preferred: the goal is fanbase growth, so recommendations imitate what works for those artists. Peers two brackets up with the same sound are secondary evidence: labeled, weighted lower, and never the sole basis for the main hypothesis. Same-bracket peers are only a baseline, or a fallback when too few next-bracket peers exist.
- The artist chooses and saves a sliding scale of peer influence for every role, including feel and wording; generation must follow those settings.
- The artist is the signed-in user; there is no separate owner login. Roles below describe parts of a draft, not account permissions.
- The POC serves Nathan only. Expanded storage and custom model work are deferred.

### Session 2026-10-25

- The owner states that YouTube granted the derived-metrics amendment (III.L). Brackets ship on, with no switch. Numbers calculated from YouTube statistics are allowed: computed in code from stored data and labeled "calculated". Qualitative reasoning over the artist's own analytics is allowed.
- The model never emits statistics. Statistics may appear in prompts; recommendation text is stripped of any count, percentage, total or spelled-out quantity the model writes.
- Unchanged: every stored YouTube statistic lives at most 30 days, enforced by the database; per-release peer lists are never merged, counted or weighted across channels (III.E.2.a); peers stay individual labeled examples.
- Long-lived citations keep an internal reference to the expired evidence, never a peer's name or ID (Developer Policies III.E.4.d has no exemption for IDs).
- Slider defaults: Sound 1, Feel 0, Wording 0, Discovery 4, Structure 4. Without an approved brand guide, defaults apply and saving waits for one.
- A research failure never fails the release: the draft proceeds without peer evidence and says so.
- YouTube API policies MUST NOT be violated, including during the POC. The owner states that YouTube accepted the derived-metrics amendment (III.L, recorded 2026-10-25), so brackets and calculated numbers are allowed (III.E.4.h). Calculated numbers are labeled as such; reported numbers are shown exactly as YouTube returns them; no combined performance score. Every stored YouTube statistic, peer or artist, is kept at most 30 days, and the database enforces that (III.E.4.b–d). Peers always stay individual examples, never cross-channel totals (III.E.2.a).
- Labels, compilations, and multi-artist curator channels are not comparable artists. Uncertain matches are skipped.
- Supersedes, for the research and learning stages: constitution III (page-driven, no background workers), AGENTS.md's no-workers and page-driven rules, PRD R7's page-driven status, the PRD non-goal on competitor research, constitution II and the AGENTS.md `ARTIST_VOICE` rule (voice grounded only in the artist's own writing; peers may now shape wording and feel per the artist's sliders), PRD R4's top-5 most-viewed audience evidence (replaced by FR-020), and the Platform Terms rule against calculated numbers and grouping channels by statistics (owner's statement of YouTube's acceptance, 2026-10-25). Constitution 2.0.0 (2026-10-22) amends II and III and adds Platform Terms for this; AGENTS.md and the PRD follow at implement.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Learn from relevant artists without copying them (Priority: P1)

The artist runs the pipeline and gets a recommendation informed by comparable artists who are doing better, while keeping their own voice.

**Why this priority**: Peer evidence gives an underground artist useful ideas before they have much history of their own.

**Independent Test**: Run with similar artists at different performance levels and distinct writing styles; verify the recommendation uses relevant peers and follows the role rules.

**Acceptance Scenarios**:

1. **Given** the artist's sound, genre, and current performance, **When** peers are selected, **Then** they come from the next bracket up whenever enough exist, and same-bracket peers fill in only as a baseline or fallback. Each match has an explanation.
2. **Given** peer evidence, **When** a draft is produced, **Then** each part uses only sources allowed by its role and identifies the evidence behind it.
3. **Given** little artist history or few suitable peers, **When** the pipeline runs, **Then** it still produces a recommendation and makes the evidence limits clear.
4. **Given** the same song and source evidence, **When** a role's slider moves from no peer influence through a blended setting to strongest peer influence, **Then** generated examples reflect that increasing influence for that role while preserving song facts and content rules.
5. **Given** saved slider defaults, **When** the artist starts a later pick, **Then** those settings apply without being entered again and without changing an already approved draft.
6. **Given** channels in the same subscriber-count range with different views and engagement, **When** peers are evaluated, **Then** their bracket stays the same and those other metrics inform example selection separately, without a combined score.

---

### User Story 2 - Test a recommendation and learn from the result (Priority: P1)

The pipeline turns peer patterns into recommendations to test, then uses the artist's actual results to improve later recommendations.

**Why this priority**: A pattern that works for another artist needs evidence that it also works here.

**Independent Test**: Publish an adopted recommendation, provide its measured results, and run the pipeline again; verify those results inform the next recommendation.

**Acceptance Scenarios**:

1. **Given** available artist history, **When** the pipeline runs, **Then** it combines those outcomes with relevant peer evidence and explains the recommendation.
2. **Given** an adopted recommendation, **When** its public release has results, **Then** the next run links the actual published treatment to those results.
3. **Given** artist outcomes that conflict with peer patterns, **When** the next recommendation is produced, **Then** it explains which evidence it follows and why.
4. **Given** missing, delayed, or revised results, **When** the pipeline runs again, **Then** it preserves uncertainty and updates existing observations without double-counting.
5. **Given** a successful release with a new song and changed metadata, **When** the pipeline learns from it, **Then** it may recommend trying the observed pattern again but does not credit an individual tactic with causing the growth.

---

### User Story 3 - Run without paid research or extra administration (Priority: P1)

Research and learning run in the pipeline without another subscription or a separate experiment-management task.

**Why this priority**: The artist has no marketing budget and wants as little interaction as possible.

**Independent Test**: Start research, close the browser, and return after it finishes; verify saved results are available without paid data access or additional forms.

**Acceptance Scenarios**:

1. **Given** research or learning is running, **When** the browser closes, **Then** that work continues and saves its result.
2. **Given** a free source is unavailable or quota-limited, **When** the pipeline runs, **Then** it identifies the missing evidence without using a paid fallback or blocking the existing review flow.
3. **Given** a normal release, **When** the artist approves it, **Then** no additional experiment form or analytics dashboard is required.
4. **Given** an ordinary page visit, **When** saved results are displayed, **Then** the visit does not launch research.

### Edge Cases

- Sparse artist or peer data: report uncertainty rather than inventing a successful strategy.
- Missing subscriber counts: leave the bracket unknown rather than estimating it from views or engagement.
- Few next-bracket peers in a niche sound: fall back to same-bracket peers, and say so, and lean on two-up peers only as secondary evidence. Never widen to other genres.
- Viral outliers, different release ages, or different formats: do not treat them as equivalent comparisons.
- Private uploads: do not mistake upload verification for public performance.
- Metadata edited after approval (for example in YouTube Studio): learn from the metadata read back at learning time, and flag that it differs from what was approved.
- A Short and its parent video: separate releases with separate outcomes.
- Per-video subscriber gains count only subscriptions made on that video's page, so they're reported as a lower bound.
- Little artist writing: identify weak voice evidence rather than silently borrowing a peer's voice.
- A slider favors unavailable evidence: report the limitation rather than inventing that evidence or silently changing the saved setting.
- Retries, revised reports, or revoked access: avoid duplicate results and unauthorized use.
- Shared genre vocabulary: distinguish ordinary discovery terms from copied distinctive phrasing.

## Requirements _(mandatory)_

### Functional Requirements

**Research and learning**

- **FR-001**: The objective MUST be fanbase growth. The artist's own outcomes measure it with subscribers gained and lost plus views. Peer evidence measures public reach and engagement per release and MUST be labeled as reach, never as fans gained. Views alone MUST NOT be presented as fans gained.
- **FR-002**: Research MUST use free YouTube public data and artist-authorized analytics, with no paid data provider or trial dependency. Analytics consent MUST be optional: without it, the artist's outcomes are unknown and approval is never blocked.
- **FR-003**: Research and learning MUST run as pipeline stages and continue independently of the browser; page visits MUST NOT trigger them.
- **FR-004**: The pipeline MUST use available artist history, including releases predating Soundboard, and relevant peer results.
- **FR-005**: Peer research MUST consider ordinary releases alongside successes and distinguish public observations from private artist outcomes.
- **FR-006**: A recommendation MUST identify the approach to test, the evidence behind it, and the intended fan-growth outcome.
- **FR-007**: The system MUST retain what was actually adopted and published, connect it to measured results, and use those results in later recommendations as promising patterns to try again, not proof that a particular tactic caused growth.
- **FR-008**: Judgments about what grows the fanbase MUST reflect evidence relevance and strength; repeated comparable artist outcomes MUST outrank loosely matched peer observations. Individual tactics MUST remain tentative; repetition across comparable releases MAY strengthen a pattern but MUST NOT be presented as proof of causation. Artist preferences about output influence MUST NOT be treated as proof of audience success.
- **FR-009**: Artist edits and approvals MUST remain preference feedback, separate from evidence of audience success.
- **FR-010**: Missing data MUST remain unknown, revised reports MUST replace earlier observations, and comparisons MUST identify their source and reporting period. Any number shown MUST either be exactly as YouTube reports it or be computed in code from stored data and labeled as calculated. Model output MUST NOT contain statistics.
- **FR-011**: Free-source failures MUST NOT cause paid fallback or prevent the existing review flow from producing a draft with clear evidence limits.
- **FR-012**: Research MUST respect source quotas and data-use permissions; private results MUST be accessible only to that artist, and expired or revoked evidence MUST NOT support new claims.
- **FR-013**: Recommendations MAY influence existing metadata and Short-selection capabilities while preserving the current approval and content rules.
- **FR-014**: A normal release MUST require no additional mandatory experiment setup or outcome-entry form.
- **FR-015**: Every stored YouTube statistic, peer or the artist's own, MUST carry its retrieval time and MUST be deleted or refreshed within 30 days. The database MUST enforce this: statistics older than 30 days MUST be unreadable by the app and MUST be deleted on a daily schedule that runs even when nobody is using the app. Long-term learning MUST keep only the artist's own authorized outcomes and what was adopted. Peer releases MUST stay individual labeled examples, never combined into cross-channel totals. The artist's authorization MUST be rechecked at least every 30 days. After 30 days, stored citations on drafts and recommendations MUST keep a reference to the expired evidence and its expiry date, but not the peer's name, ID or statistics.

**Performance brackets** (on: the owner states YouTube accepted the derived-metrics amendment, 2026-10-25)

- **FR-016**: Peers MUST first match the artist's sound and genre; brackets then order them. The review MUST show each peer's statistics as YouTube reports them, with any calculated figure labeled as calculated. When the artist's or a peer's subscriber count is hidden, its bracket MUST stay unknown and the recommendation MUST say bracket targeting was unavailable for it.
- **FR-017**: Brackets MUST use reported subscriber-count ranges, with the same range boundaries for Nathan and peers. Views and engagement MUST remain separate evidence for selecting useful releases; calculations MUST be limited to simple arithmetic on YouTube metrics, with no combined performance score. A combined views-plus-audience bracket score is out of scope.
- **FR-018**: Peers MUST be artist channels that share the artist's sound and genre; labels, compilations, and multi-artist curators MUST be excluded, and uncertain matches skipped. Peer selection MUST always prefer the next bracket up, and recommendations MUST be modeled on what works for those peers. Same-bracket peers MAY serve only as a baseline, or as a fallback when too few next-bracket peers exist. The recommendation MUST say when it fell back. Peers two brackets up MAY add secondary evidence: labeled as such, weighted below next-bracket peers, and never the sole basis for the main hypothesis. Peers further up MUST NOT be used. Each peer MUST record its match basis (heard or metadata-only) and an explanation; metadata-only matches MUST be labeled.
- **FR-019**: The review MUST identify the current and target subscriber-count ranges and consider recent release results separately. A bracket changes only when the reported subscriber count crosses a range boundary, not because one release gains unusually high views or engagement.
- **FR-020**: Eligible peer releases MUST replace the genre search's most-viewed videos as structure evidence. Tag and hashtag candidates MUST come from eligible peer releases plus the genre search. Each release's terms MUST stay a separate, labeled list: never merged, counted or weighted across channels (III.E.2.a). Drafts MUST still use candidates only.

**Artist identity and borrowed evidence**

- **FR-021**: Each role MUST have an artist-adjustable slider from no peer influence to strongest peer influence, with intermediate settings blending artist and peer sources. This includes feel and wording. The defaults below MUST work without setup; the slider expresses relative influence, not an exact percentage of generated words.

| Role      | Default sources                                                                      |
| --------- | ------------------------------------------------------------------------------------ |
| Sound     | Song analysis; peer vocabulary may help describe it                                  |
| Feel      | The artist's own writing and approved edits                                          |
| Wording   | The artist's phrasing, sentence shape, and asides                                    |
| Discovery | Eligible peer tags, hashtags, and title keywords, limited to what the analysis heard |
| Structure | Peer patterns for length and order; the artist's own identity and credit lines       |

- **FR-022**: Peer descriptions, titles, and comments MAY inform tone and phrasing according to the saved sliders. At the strongest setting, wording and feel MUST cite at least two peers. Copied sentences and distinctive phrases remain prohibited. Shared discovery terms are allowed.
- **FR-023**: Slider settings MUST be saved as the artist's defaults with their brand guide and used for their later picks and re-runs. Each draft MUST retain the settings used to generate it; changing defaults MUST NOT rewrite approved drafts.
- **FR-024**: Before review, a draft MUST be checked against the configured influence settings through the sources it cites for each role: with no peer influence, no peer source is cited for that role; at the strongest setting, peer sources are cited; in between, both artist and peer sources are cited. A mismatch MUST be retried once, then shown with an "influence settings not met" warning without blocking review. Deliberately selected peer influence MUST NOT itself trigger a voice warning.
- **FR-025**: Generation MUST adjust each role according to its saved slider, including wording and feel. Settings MUST NOT override song facts, artist identity and credits, candidate-list restrictions, or approval rules; learning MUST NOT silently change the artist's saved defaults.

### Key Entities

- **Peer**: a comparable artist, their match basis (heard or metadata-only) and explanation, and their bracket relative to the artist (same, next, or two up).
- **Evidence**: an artist outcome or public peer observation, with its source and reporting period.
- **Recommendation and result**: the proposed approach, what the artist adopted, and the measured outcome.
- **Performance bracket**: a subscriber-count range applied consistently to Nathan and peers.
- **Role setting**: the artist's saved degree of peer influence for a part of a draft, also retained with the draft that used it.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A complete research-to-learning cycle uses zero paid data subscriptions or trial credentials.
- **SC-002**: Every evidence-based recommendation identifies its sources and the role settings used. With the same source evidence, each role cites no peer source at no influence, peer sources at the strongest setting, and both in between, without changing facts or violating content rules. At the strongest setting, wording and feel each cite at least two peers.
- **SC-003**: Every selected peer records its match basis (heard or metadata-only, with metadata-only labeled) and an explanation, excludes peers Nathan rejected, and is placed using the same subscriber-count ranges as Nathan (unknown when a count is hidden). Next-bracket peers are chosen first whenever enough exist; any peer two brackets up is labeled secondary and never alone supports the main hypothesis, and none sits further up.
- **SC-004**: An adopted recommendation with available results informs the next pipeline run without manual outcome entry.
- **SC-005**: Missing-data, conflicting-evidence, and successful-release cases produce an explained recommendation without invented success claims or attributing growth to an individual tactic without causal evidence.
- **SC-006**: Closing the browser does not stop running research or learning, and retrying completed work does not duplicate its results.
- **SC-007**: The feature adds zero mandatory experiment-management actions to a normal release.
- **SC-008**: No stored YouTube statistic is readable by the app after 30 days, every one is deleted within a day after that even with no app activity, no recommendation reports a cross-channel total, every calculated number is computed in code and labeled as calculated, and no model-written statistic reaches a stored recommendation.

## Assumptions

- YouTube is the first platform; other platforms are separate features.
- Band input remains in spec 004; the analytics dashboard remains a separate future spec.
- Subscriber-count range boundaries, what counts as a comparable release (format, release age, bracket), and evidence-sufficiency rules are defined during planning from available free data.
- This is a single-user POC; expanded storage and custom models are outside this feature. Existing requirements to save settings, recommendations, and results remain.
- Pipeline execution design is a planning decision; this spec does not select a cloud service.
- Fanbase growth is the product goal, not a guaranteed outcome of every recommendation.
- The owner states YouTube accepted the derived-metrics amendment (III.L; "Section 5" → "Analytics & Reporting") and holds the acceptance record. Bracket features (FR-017–FR-019) ship on. Storage stays at 30 days.
- Hearing peer songs with Gemini on public YouTube URLs is a preview feature; relying on it needs a recorded gate.
- Genre-search statistics on jobs already expire: `job_audience` and migrations 0001–0003 hide them at 30 days and delete them daily (`docs/operations/youtube-retention.md`).

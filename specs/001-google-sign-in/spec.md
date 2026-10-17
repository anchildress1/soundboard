# Feature Specification: Google Sign-In and Connections

**Feature Branch**: `feat/sign-in-page`

**Created**: 2026-10-16

**Status**: Draft

**Input**: User description: "Proper sign-in page. Remove signed-out functionality. Support concurrent users signed in on the home page. Keep users signed in until expired." Revised in clarification: single Google sign-in for identity and YouTube, per-user channels, a Connections page for future platforms, invite-gated until open signup.

## Clarifications

### Session 2026-10-16

- Q: What happens to the dev.to embed? → A: Dropped. Judging is over; this is v2 work.
- Q: Who decides access: IAP, or the app's own Google OAuth? → A: The app's own OAuth. It supports a future open signup without managing IAP.
- Q: Is v2 multi-artist? → A: Yes, each user is an artist. Per-artist voice, memory and brand guide are spec 002. This spec covers sign-in, users, Connections and per-user ownership.
- Q: One consent screen or sign in then connect? → A: One Google screen grants identity plus YouTube upload and read.
- Q: Who can sign in before open signup? → A: An invite list. Everyone else gets a "not invited" notice.
- Q: Session lifetime? → A: Fixed 30 days from sign-in, independent per browser.
- Q: Samples and the reupload diff (old R8, R9)? → A: Removed, along with the sandbox channel.
- Q: Upload quota split? → A: One shared pool, first come.
- Q: When is a job's destination channel fixed? → A: Approval records the exact YouTube channel ID. Before an upload starts, a different destination requires fresh approval. Once the upload starts, its destination stays fixed through upload and verification. Same-channel reconnect resumes the job; disconnect pauses unfinished publishing and preserves the job and approved fields. (The destination half is superseded by the channel lock, FR-023.)

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Signed out, the app shows only sign-in (Priority: P1)

Anyone without a session sees a sign-in page with a single "Sign in with Google" action. No other app content, data or action is reachable.

**Why this priority**: Every other story depends on this boundary.

**Independent Test**: In a fresh browser, sweep all app pages and data APIs. Pages show sign-in, APIs return 401, and nothing is written. Separately verify that the sign-in initiation route and callback work without a session and static assets expose no app data.

**Acceptance Scenarios**:

1. **Given** no session, **When** the visitor opens the home page, **Then** they see only the sign-in page.
2. **Given** no session, **When** the visitor opens a job page, the brand guide or the Connections page, **Then** they land on the sign-in page.
3. **Given** no session, **When** any API is called, **Then** it returns 401 and changes nothing.
4. **Given** no session, **When** the sign-in page renders, **Then** it sets no cookies until the visitor clicks sign in.
5. **Given** no session, **When** the user clicks sign in, **Then** `/auth/login` starts Google authorization and `/auth/callback` can complete it without an existing session; neither grants access before identity and invitation checks succeed.

---

### User Story 2 - One Google sign-in grants identity and YouTube (Priority: P1)

An invited user signs in with Google once. A single consent screen grants their identity plus YouTube upload and read access. They land on the home page with their channel already connected, and stay signed in for 30 days or until they sign out.

**Why this priority**: The app can't upload without the channel grant, so sign-in and YouTube access are one step.

**Independent Test**: Sign in with an invited account, approve one consent screen, and confirm the home page shows that user's own channel with no second connect step. Close and reopen the browser and confirm the user is still signed in.

**Acceptance Scenarios**:

1. **Given** an invited Google account, **When** the user signs in and approves consent, **Then** they land on the home page with their YouTube channel shown as connected.
2. **Given** a signed-in user who has not signed out or lost access, **When** they come back within 30 days of signing in, **Then** they're still signed in.
3. **Given** a signed-in user, **When** they sign out, **Then** the next page they load is the sign-in page.
4. **Given** a user who declines the YouTube part of consent, **When** they come back from Google, **Then** they're signed in but the Connections page shows YouTube as not connected and uploads are blocked until they reconnect.
5. **Given** identity consent but only one required YouTube scope, **When** sign-in completes, **Then** identity sign-in succeeds but YouTube is not connected and approval is blocked.
6. **Given** identity consent and no usable YouTube channel, **When** sign-in completes, **Then** sign-in succeeds and Connections explains that a YouTube channel is required without marking it connected.
7. **Given** an existing valid connection, **When** returning sign-in supplies no new refresh token, **Then** the existing grant is preserved if it still has the required scopes and matches the selected channel; a different or incomplete grant never overwrites it.

---

### User Story 3 - Uninvited accounts are turned away (Priority: P1)

A Google account that isn't on the invite list finishes Google's screens, then comes back to the sign-in page with a plain "not invited" notice. No session, user record or token is kept for it.

**Why this priority**: Until open signup ships, the invite list is the only gate on the shared upload quota and model.

**Independent Test**: Sign in with an uninvited account. Confirm the notice, no session cookie, no stored user or token, and 401 from every API.

**Acceptance Scenarios**:

1. **Given** an uninvited Google account, **When** the user finishes Google sign-in, **Then** they see the "not invited" notice and stay signed out.
2. **Given** a signed-in user whose invite is revoked, **When** they make their next request, **Then** they're treated as signed out.
3. **Given** an invitation already bound to a Google account ID, **When** that account signs in with a changed verified email, **Then** its user, jobs and artist link are preserved while the invitation remains active.
4. **Given** an invitation bound to one Google account ID, **When** a different account presents the old invited email, **Then** it cannot claim that invitation or its artist link.
5. **Given** a revoked invitation later reactivated, **When** an old session is presented, **Then** it stays invalid; fresh sign-in is required to regain access.

---

### User Story 4 - Users only see and act on their own work (Priority: P1)

Each signed-in user sees only their own jobs, and approvals upload only to their own connected channel. Several users can be signed in at once on different browsers and devices without affecting each other.

**Why this priority**: With more than one artist, a crossed upload would publish one artist's video to another's channel.

**Independent Test**: Sign in as two invited users in two browsers. Each creates and approves a job. Confirm each upload lands on its owner's channel, neither user can open the other's job, and signing one out leaves the other untouched.

**Acceptance Scenarios**:

1. **Given** users A and B signed in at once, **When** A opens B's job link, **Then** A gets not-found, never B's job.
2. **Given** user A approves a job, **When** the upload runs, **Then** it uses A's channel token, never another user's.
3. **Given** A and B signed in on separate browsers, **When** A signs out, **Then** B stays signed in and B's running job continues.
4. **Given** one account signed in on two devices, **When** it signs out on one, **Then** the other stays signed in until its own session ends.
5. **Given** a signed-in user, **When** they reconnect YouTube choosing a different Google account, **Then** the attempt is rejected and their existing connection stays, so a job's channel never changes.
6. **Given** A and B interleave requests in one app process, **When** they load headers, Connections, job lists and media links or mutate Shorts, **Then** every result and mutation belongs to the requesting user; caches and credentials never cross users.
7. **Given** a user without an artist link, **When** their pick runs, **Then** it runs with no artist memory or identity and stores feedback only on that job; it never reads or writes FLR memory.

---

### User Story 5 - The Connections page manages platform links (Priority: P2)

A signed-in user opens Connections and sees each platform with its status: connected (with the account or channel name) or not connected. They can reconnect or disconnect YouTube. Future platforms join the same page and may use a different account from the sign-in account.

**Why this priority**: Tokens get revoked and channels change; users need a place to fix that without support.

**Independent Test**: Revoke the app's access from the Google account settings, then open Connections. Confirm YouTube shows "reconnect", and reconnecting restores uploads.

**Acceptance Scenarios**:

1. **Given** a connected YouTube channel, **When** the user opens Connections, **Then** they see the channel name and a Disconnect action.
2. **Given** a revoked or expired YouTube grant, **When** the user opens Connections or tries to approve, **Then** they see a plain "reconnect YouTube" prompt and approval is blocked until they do.
3. **Given** the user disconnects YouTube, **When** it completes, **Then** the stored grant is deleted and approvals are blocked until they reconnect.
4. **Given** an approved job paused by a missing or disconnected grant, **When** its owner reconnects the approved channel, **Then** the job resumes from its next unfinished publishing or verification step with its approved fields preserved and without starting a second upload.
5. **Given** an approved job, **When** its owner disconnects YouTube, **Then** no further publishing or verification step starts, and the job, its destination, approved fields and completed upload progress are preserved; an already-running external request may finish against the original channel.
6. **Given** A starts reconnect, **When** the browser signs out or switches to B before the callback, **Then** the attempt is rejected and neither user's existing connection changes.
7. **Given** a connected user, **When** reconnect is cancelled, expires or fails identity, scope or channel validation, **Then** the existing connection is preserved and no partial replacement is stored.
8. **Given** access is lost before approval, before upload initiation, during upload or before verification, **When** the same channel is reconnected, **Then** edited fields and durable progress remain; unapproved work still requires approval, approved work resumes when its page drives the next step, and verification never initiates another upload.
9. **Given** YouTube refuses an upload because the project's or the channel's daily upload limit is reached, **When** the step runs, **Then** the job pauses with "Daily upload limit reached. Try tomorrow." and continues from the same point once the limit resets.
10. **Given** a job paused because its approved channel is no longer connected, **When** the owner discards it, **Then** no further step runs, and any video ID YouTube already returned stays recorded on the job.
11. **Given** the final upload response was lost, **When** recovery checks the session, **Then** a completed result proceeds to verification without another upload; an unavailable session pauses with "upload outcome unknown" and a link to the channel's uploads in YouTube Studio.
12. **Given** a job paused with "upload outcome unknown", **When** any amount of time passes, **Then** it stays paused and the app never uploads again on its own.
13. **Given** a job paused with "upload outcome unknown", **When** the owner pastes a video URL, **Then** the app checks that video is on the pinned channel, records its ID and continues normal read-back; a missing or wrong-channel video is rejected without changing the job.

---

### User Story 6 - Return to interrupted work (Priority: P1)

The signed-in home page lists only the user's jobs, newest first, with song title, state and a link to continue.

**Why this priority**: Deep links don't survive sign-in, so the job list is the only way back to unfinished work.

**Independent Test**: Expire a session mid-run, sign in again, find the job on the home page and continue it without losing saved progress.

**Acceptance Scenarios**:

1. **Given** a session expired mid-run, **When** the owner signs in again, **Then** their home page lists the job and its link resumes the next unfinished step.
2. **Given** unfinished work whose source or rendered media has expired, **When** its owner opens the job, **Then** saved metadata remains visible and the page explains that media-dependent work requires a new upload; it does not promise automatic recovery of deleted media.
3. **Given** two signed-in users, **When** each opens the home page, **Then** neither job list contains the other's work.

---

### Edge Cases

- A session expires mid-run: the next step call returns 401 and the page sends the user to sign in. The job stays put; after sign-in the owner finds it on the home page and resumes if the required media is still available.
- A tampered, malformed or expired session is treated as signed out. It never errors and never grants access.
- The user takes longer than 10 minutes on Google's screens: they come back to sign-in with a plain "sign-in expired, try again" notice.
- A deep link opened while signed out leads to sign-in, then to the home page. Returning to the original link is out of scope.
- Brand Account channels are out of scope; no current user has one. Each user connects their own Google account's channel.
- Google returns no new long-lived grant: preserve an existing valid matching grant; otherwise show YouTube as not connected and require Reconnect.
- YouTube's daily upload limit is reached, for the project or for one channel: the job pauses with a plain "daily upload limit reached, try tomorrow" message and continues after the reset. Nothing is queued.
- The app's OAuth verification is still pending: users see Google's unverified-app screen during consent. Expected until verification is done.
- An invited user's email changes at Google: the user is identified by their stable Google account ID, not their email, so their data stays theirs.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Without a valid session, every app page MUST show the sign-in page. `/auth/login`, `/auth/callback` and public static assets are explicit exceptions; auth routes MUST validate their own flow and MUST NOT expose app data.
- **FR-002**: Without a valid session, every app data or mutation API MUST return 401 and change nothing. The auth exceptions in FR-001 MUST be tested separately; no wildcard route exemption is allowed.
- **FR-003**: The sign-in page MUST offer "Sign in with Google" as its only action and MUST show no app data.
- **FR-004**: Sign-in MUST request identity plus YouTube upload and read access on one Google consent screen, with a long-lived grant.
- **FR-005**: While invite gating is enabled, only accounts with an active invitation MUST get a session. First redemption MUST atomically bind a normalized invited email to the verified Google account ID; another ID MUST NOT redeem it. Others MUST see a "not invited" notice and MUST leave no stored session, user record or token behind.
- **FR-006**: Access MUST be re-checked on every authenticated request using the user ID and current access generation. Revoking an invite MUST invalidate its existing sessions on the next request and advance that generation; reactivation MUST NOT revive old sessions. A bound user's later email change MUST NOT alter ownership or transfer invitation or artist access.
- **FR-007**: The invite list MUST be switchable to open signup by one setting, with no code change.
- **FR-008**: A user MUST be identified by their stable Google account ID. Email is for display and invites only.
- **FR-009**: A session MUST last a fixed 30 days from sign-in, unless the user signs out or loses access sooner. Activity MUST NOT extend it.
- **FR-010**: An expired, tampered or malformed session MUST be treated as signed out.
- **FR-011**: Sessions MUST be independent per browser. Signing in, signing out or expiry in one MUST NOT affect another.
- **FR-012**: Every job MUST belong to the user who created it. Other users MUST get not-found for it in every page and API.
- **FR-013**: Each user's YouTube grant MUST be stored per user. An approval MUST upload only through its owner's grant.
- **FR-014**: The Connections page MUST list each supported platform with its status and allow Connect, Reconnect and Disconnect. YouTube is the only platform in this spec. A user has at most one YouTube connection, always on their own Google account.
- **FR-015**: A connection MUST record its own platform account. YouTube MUST use the signed-in Google account; future platforms MAY use a different account.
- **FR-016**: A revoked or missing YouTube grant MUST block approval with a "reconnect YouTube" prompt, and MUST NOT fail the job.
- **FR-017**: Daily uploads draw from YouTube's per-project limit, shared across all users, first come. The app MUST NOT keep its own upload count. YouTube's project quota-spent and per-channel upload-limit responses MUST pause the job, never fail it.
- **FR-018**: Until spec 002, the single artist profile (memory, recent-video identity, brand guide) MUST stay as it is today for the user linked to it. Only that user's picks MAY read or write its memory or use its identity, and only that user MAY open its brand guide. Picks for users without an artist link MUST run with no artist memory or identity, and their feedback MUST stay on the job.
- **FR-019**: The app MUST refuse to be framed by any origin but its own.
- **FR-020**: These MUST be removed, with their code, config and tests: the anonymous visitor path and its run caps, the 5-minute visitor limit, demo accounts and `DEMO_EMAILS`, the email allowlist env, samples, the reupload diff, the sandbox channel, and per-channel connect routing.
- **FR-021**: The PRD and AGENTS.md MUST be updated to match.
- **FR-022**: Approval MUST display and record the exact destination YouTube channel ID and name. Publishing and verification MUST use only the job owner's grant verified for that channel, never a different currently connected channel.
- **FR-023**: Connect and Reconnect MUST be rejected unless the granting Google account ID equals the signed-in user's, so a user's YouTube channel never changes. Upload initiation MUST be durably marked before the external request, and a resumable session expiring, being cleared or being replaced MUST NOT clear that mark.
- **FR-024**: Disconnecting or losing access to an approved destination MUST pause unfinished publishing and verification without failing the job or losing its approved fields or completed progress. Reconnecting the same channel MUST resume the next unfinished step without a duplicate upload. A request already in flight MAY finish against the original destination.
- **FR-025**: The owner MUST be able to discard a job paused under FR-024. Discarding MUST stop future app steps but MUST NOT claim to delete a video or cancel a request already accepted by YouTube. Existing video IDs and outcomes MUST remain recorded; external video deletion is outside this spec.
- **FR-026**: Connect and Reconnect MUST bind the authorization attempt to the initiating user with a ten-minute expiry. The callback MUST reject expired, replayed or mismatched attempts, including when the browser's current session belongs to a different user or has ended. Success MUST NOT replace the sign-in identity; cancellation or failed validation MUST preserve the prior connection.
- **FR-027**: YouTube MUST be marked connected only after confirming both upload and read scopes, a usable long-lived grant and the selected channel's ID and name through that grant. Partial consent or no channel MUST allow identity sign-in but block approval with an actionable Connections status. A missing new refresh token MUST NOT erase a valid existing matching grant. New credentials MUST be validated before replacing the stored connection.
- **FR-028**: Grant-related pauses MUST preserve edited fields, approval, destination, upload progress and any returned video ID. Same-channel recovery MUST NOT repeat approval or duplicate an upload. Recovery MUST check the stored session's status before retrying: completed uploads proceed to verification, confirmed incomplete uploads resume, and a lost session where the final bytes were never sent MAY restart on the same destination. A lost session after final bytes may have been sent MUST pause with "upload outcome unknown" and link to the channel's uploads in YouTube Studio. The app MUST NOT search for the video or upload again on its own. The owner MAY paste the video's URL; the app MUST check the video is on the pinned channel through the owner's grant before recording its ID for normal read-back verification. Otherwise the job MUST stay paused and the owner MAY discard it (FR-025). An authorization failure MUST be treated as lost access, never as unknown completion.
- **FR-029**: The signed-in home page MUST list only the user's jobs with title, state and a continuation link. Resume MUST respect the seven-day media lifecycle; missing media MUST produce a clear new-upload requirement while retaining saved metadata.
- **FR-030**: User-specific caches, channel statistics, connection state, job lists, media URL issuance and all video/Short mutations MUST be isolated by user and, where relevant, channel. A signed URL MUST be issued only after checking job ownership; existing issued URLs retain their bounded expiry and are not revoked by sign-out.

### Key Entities

- **User**: one person, keyed by Google account ID. Holds email, display name, sign-in time and an optional link to an artist profile.
- **Invite**: a normalized invited email, active status, optional artist profile link and Google account ID bound on first redemption. Seeded with Nathan (linked to the FLR profile) and Ashley; revocation advances the bound user's access generation.
- **Session**: a signed browser credential naming the user, their access generation and a fixed expiry 30 days after sign-in. Holds no role; access is re-checked against current user and invitation state on each request.
- **Connection**: one user's link to one platform account (YouTube now). Holds the platform, the platform account ID and name, the grant's status and the encrypted grant.
- **Job**: owned by a user ID instead of the `nathan` / `demo` / `visitor` owner labels. Approval records the destination channel ID and name alongside the approved fields; the destination becomes immutable when resumable upload initiation starts.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: An automated route sweep finds that 100% of app pages and data/mutation APIs refuse signed-out requests; `/auth/login`, `/auth/callback` and public static assets are enumerated and independently tested exceptions.
- **SC-002**: A signed-out home page visit sets zero cookies.
- **SC-003**: A new invited user granting both YouTube scopes with an available channel reaches home with that channel connected through one combined consent flow; application-controlled callback processing completes within one minute, excluding user interaction and provider outages.
- **SC-004**: A returning user within 30 days stays signed in unless they signed out, their access was revoked, or the credential is invalid. Activity never extends the original expiry; expiry on one browser does not affect another.
- **SC-005**: Interleaved A → B → A requests in one app process expose zero crossed jobs, header/channel data, Connections, job-list entries or newly issued media URLs, and allow zero cross-user video or Short mutations. Run browser coverage on desktop Chrome and Pixel 7.
- **SC-006**: Same-channel Reconnect restores eligible work before initiation, during upload and before verification, preserving fields and progress without a duplicate upload; expired media follows FR-029.
- **SC-007**: Executable legacy visitor/demo/sample/sandbox/embed behavior and obsolete active setup guidance are removed. Historical artifacts and requirements describing removal are exempt from keyword matching; retired routes do not remain usable.
- **SC-008**: Automated tests cover reconnects from another Google account rejected, cancelled/expired/replayed callbacks, read-only/upload-only/neither-scope grants, no channel, missing refresh tokens, email changes, invite reactivation, the upload-start mark surviving session reset, lost completion responses that stay paused with no automatic upload, pasted video URLs accepted only on the pinned channel, and picks for unlinked users that read and write no artist memory.

## Evidence Boundary

- Automated tests mock Google at process boundaries; the deployed manual checks supply real provider evidence.

## Assumptions

- Google is the only sign-in provider. The Connections page structure allows more platforms later, but none are built here.
- Signed session cookies stay; a per-user access generation supports revocation without a server-side session store.
- The "sign-in page" is the home route's signed-out view, not a separate URL.
- Pre-beta, so nothing is migrated. Nathan signs in with an invite linked to `flr`; his artist memory restarts from the seed facts, the brand guide is proposed again, and old jobs and stored grants are left behind.
- The app's OAuth consent screen stays "In production" and unverified. Google's unverified-app screen and user cap apply until verification, which is outside this spec.
- YouTube's per-project upload limit is 100 a day (Cloud Console, 2026-10-17); a channel's own cap may be lower and is unpublished. A quota increase needs Google's YouTube API audit, outside this spec.
- Neon Postgres replaces Firestore as the database; the user, invitation, connection, job and artist tables are defined under this spec.
- Per-artist voice, memory, brand guide and per-artist quotas are spec 002.
- Reconnect callbacks belong to the user who started them; signing out or switching users invalidates the attempt, and failed attempts keep the current connection.
- First sign-in binds an invitation to the verified Google account ID. Later email changes don't move that binding. Revoking an invitation invalidates existing sessions for good; re-inviting needs a fresh sign-in.
- Users get back to interrupted work through the home page's job list. Work that depends on source media resumes only while that media is still stored.

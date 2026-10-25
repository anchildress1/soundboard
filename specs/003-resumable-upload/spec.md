# Feature Specification: Resumable video upload

**Feature Branch**: `003-resumable-upload`

**Created**: 2026-10-22

**Status**: Draft

**Input**: User description: "The upload will be slow on the user's end. We need a plan to accommodate frequent stops and starts." The destination stays the project's storage bucket.

## Clarifications

### Session 2026-10-22

- Q: Upload straight to YouTube and have the model read it there? → A: No.
  - The model reads only public YouTube videos, and these are unreleased songs.
  - Audio measurements and the Short render need the original file.
  - Every analysis would spend shared YouTube upload quota.
  - The upload would need the user's YouTube token in the browser.
- Q: Separate feature or part of the model swap? → A: Separate feature. The order is 002 Gemini, 003 resumable upload, 004 band info.
- Q: After a reload or a closed tab, how does the upload continue? → A: The user picks the video again. The file is not copied into browser storage.
- Q: A different file is picked for an unfinished upload? → A: Never refuse it. It starts a new upload for that job.
- Q: Background upload? → A: Wanted, but there's no way to do it on the web in every browser. The only web API for it (Background Fetch) exists in Chromium browsers only, not Firefox or Safari, so it's dropped.
  - The upload keeps running while the user moves around the app, and for as long as the browser keeps the tab alive.
  - When the browser stops it, coming back to the page says so and continues.
- Q: Which browsers? → A: All current browsers, not just Chrome.
- Q: Testing scope? → A: Web testing only for now. No real-device runs. Phone readability of messages is a later problem.

### Session 2026-10-25

- Q: How is the saved session protected at rest? → A: Encrypted the same way as YouTube refresh tokens. Requests name the session by a version number, never by its address.
- Q: How is "the same video" recognized? → A: By size, name, last-modified time and dense samples of the file's content, not a whole-file hash. A file that differs only between samples is treated as the same file.
- Q: What does the page say while storage itself is busy? → A: "Upload paused: storage busy, retrying", at the saved amount.
- Q: What if the same video is picked on two devices? → A: The newer pick wins. The older sender stops with "The upload moved to another device or window." and shows the file prompt.

## User Scenarios & Testing _(mandatory)_

### User Story 1: A dropped connection doesn't restart the upload (Priority: P1)

Nathan uploads a 1.2 GB video on a slow connection that keeps dropping. Each drop pauses the upload. When the connection comes back, the upload continues from what storage saved. It never starts again from zero.

**Why this priority**: Today one dropped connection throws away everything sent so far. On a slow link, a large video may never finish.

**Independent Test**: Drop the connection several times mid-upload. The upload finishes, and the bytes received are close to the file size.

**Acceptance Scenarios**:

1. **Given** an upload at 40%, **When** the connection drops, **Then** the page shows "Upload paused: no connection" with the saved amount. It shows no error.
2. **Given** a paused upload, **When** the connection returns, **Then** the upload continues on its own from the saved amount, with no tap needed.
3. **Given** an upload that has been interrupted 20 times, **When** it finishes, **Then** the job moves to analysis exactly as an uninterrupted upload does.
4. **Given** storage reports an error that is safe to retry, **When** the uploader sees it, **Then** it retries with growing delays and keeps the saved amount.

---

### User Story 2: Moving around doesn't stop the upload (Priority: P1)

Nathan starts an upload and goes back to the job list or opens another job. The upload keeps sending. If the browser stops it (the tab is hidden too long, the phone sleeps, or the tab is closed), coming back to the job page says so.

**Why this priority**: He shouldn't have to stare at a progress bar. When the browser does stop the upload, he has to know.

**Independent Test**: Start an upload, navigate within the app, and come back. Bytes kept arriving. Then simulate the browser stopping the upload. On return, the page shows the away message and continues.

**Acceptance Scenarios**:

1. **Given** an upload in progress, **When** Nathan opens other pages in the app, **Then** sending continues.
2. **Given** the upload finished while he was elsewhere in the app, **When** he opens the job page, **Then** it starts analysis as if he had watched.
3. **Given** the tab was hidden or frozen and sent nothing while hidden, **When** it becomes visible again, **Then** the page says "The upload paused while you were away." with the saved percentage and continues at once.
4. **Given** the tab was closed or reloaded, **When** Nathan opens the job page again, **Then** it shows the saved percentage and asks for the file (User Story 3).

---

### User Story 3: Continue after a reload or a closed tab (Priority: P1)

The browser loses the file (a reload, a killed tab, a closed browser). When Nathan opens the job again, the page shows how much is saved and asks for the video. The same video continues from the saved amount. A different video starts over for this job.

**Why this priority**: Without it, any lost tab means a new job and a full restart.

**Independent Test**: Reload at 30% and pick the same file: it continues from about 30%. Reload and pick a different file: it starts from zero, and that file is the one that lands.

**Acceptance Scenarios**:

1. **Given** an unfinished upload and a page with no file, **When** the job page opens, **Then** it shows "Upload paused at 30%. Pick the video to continue." with a file picker. If the saved amount can't be read, it shows "Pick the video to continue." with no percentage.
2. **Given** that prompt, **When** Nathan picks the same video, **Then** the upload continues from 30%.
3. **Given** that prompt, **When** Nathan picks a different video, **Then** the upload starts from zero with it, and the page says "New video: starting the upload over."
4. **Given** the job list on the home page, **When** a job's upload is unfinished, **Then** its row still reads "Uploading" and opens the job page.

---

### User Story 4: Discard stops an unfinished upload (Priority: P3)

Nathan discards a job while its upload is paused or running. The upload stops, and nothing of it lands in storage.

**Why this priority**: It's rare, but a discarded job must not leave a video behind or keep sending.

**Independent Test**: Discard mid-upload and confirm no object exists for that job.

**Acceptance Scenarios**:

1. **Given** an upload in progress, **When** Nathan discards the job, **Then** sending stops and no object for the job is created.

---

### Edge Cases

- **Session expires (7 days, the same as the bucket's media lifetime).** The next attempt starts a fresh session from zero and says "The saved upload expired; starting again." It never fails the job for this.
- **A different video after a partial upload.** The old session is cancelled. The job's single file slot can't hold both.
- **A file over 2 GB, over 15 minutes, or not a video.** It's refused with today's create messages. Storage also refuses any upload that doesn't match its declared size.
- **Two tabs on the same job.** Only one sends. The other shows "Uploading in another tab" and takes over with the file prompt when the sender's tab closes.
- **Two tabs or devices with different files.** The newer pick wins, even across devices and app addresses. The other stops with "A different video replaced this upload." and shows the file prompt, so picking again makes it the newest. Automatic retries never take the upload back.
- **The upload already landed.** A late re-pick or a second device can't overwrite it. The page moves on to analysis.
- **Re-picked on a different app address** (custom domain vs a run.app URL). The upload continues on the same session; storage accepts it from any address, so the session's secrecy is what protects it.
- **The last bytes arrived but the reply was lost.** On reconnect, the uploader asks storage, sees the upload is complete, and moves on without resending.
- **The job page is opened on another device.** It shows the saved amount. The upload continues only where the file is.
- **Upload left unfinished for days.** The job stays "Uploading" until the session expires (it restarts on the next pick) or the job is discarded. Automatic cleanup of abandoned partials is a later item (TTD).

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The video MUST upload straight from the browser to the project's storage bucket in a resumable session. Media bytes MUST never pass through the app.
- **FR-002**: The session MUST be created for one job's object, with the file size declared up front. Storage refuses any upload whose size doesn't match.
- **FR-003**: After any interruption, the uploader MUST ask storage how much it saved and send only the rest. It MUST never trust its own count over storage's.
- **FR-004**: Network loss, timeouts and storage errors that are safe to retry MUST pause the upload, never fail the job. A connection pause and a storage-busy pause MUST say which they are. The upload MUST resume on its own when the connection returns, with growing delays between retries.
- **FR-005**: The upload MUST keep running while the user navigates within the app. It MUST NOT depend on the job page being open.
- **FR-006**: When the tab was hidden or frozen and sent nothing while hidden, the page MUST say "The upload paused while you were away." with the saved percentage on becoming visible, and continue at once. After a reload or a closed tab, FR-008 and FR-009 apply.
- **FR-007**: The session MUST be kept with the job, so a reload or a reopened tab can resume it. Only the job's owner MUST be able to get it. It MUST be encrypted at rest like the YouTube refresh tokens, never sent back in a request, and never logged, traced or shown.
- **FR-008**: When the browser has no file for an unfinished upload, the job page MUST show the saved percentage (looked up by the server) and a file picker.
- **FR-009**: A picked file whose sampled fingerprint (size, name, last-modified time, first and last 1 MiB, and 64 evenly spread 64 KiB samples) matches the original's MUST resume. A file that differs only between samples is treated as the same file. Any other file MUST start a new upload: the old session is cancelled, the new file is checked against today's caps, and its name, size and fingerprint are recorded. A different file MUST never be refused for being different.
- **FR-010**: The page states and their text MUST be the list in the contract (`contracts/upload-session.md`, Page states). After a pause, `n` is what storage confirmed.
- **FR-011**: An expired or missing session with the upload unfinished MUST start a new session from zero, with a plain message. If storage reports the upload complete, the job MUST move on without resending.
- **FR-012**: Only one sender MUST run for a job at a time, across tabs and devices. A newer pick always wins, including the same file picked on another device; the older sender stops and offers the file prompt, and automatic retries never take the upload back.
- **FR-013**: Discarding a job with an unfinished upload MUST stop sending and cancel its session. An object that lands for that unfinished upload anyway MUST be deleted, at once or on the job's next touch; anything missed goes with the bucket's 7-day delete rule. Discarding a job whose upload already finished MUST NOT delete its video. The working screen MUST offer Discard while the upload runs or is paused.
- **FR-014**: Once the object lands, it MUST NOT be overwritten, and the pipeline MUST behave exactly as today. Analysis starts from the open job page.
- **FR-015**: Sentry MUST record upload pauses and resumes as breadcrumbs, with amounts only. No session address, no file name beyond today's, and no media.
- **FR-016**: The upload MUST work in current Chrome, Edge, Firefox and Safari, on desktop and mobile.
- **FR-017**: The PRD (R1) MUST describe the resumable upload in place of the single signed upload.

### Key Entities

- **Job**: gains its video upload (encrypted session, version number, size and fingerprint; owner-only, never logged), used only while the job is uploading. A new file replaces all of it. Every pick raises the version.
- **Upload session**: one live session per job, valid up to 7 days, bound to the job's object and declared size. Storage, not the app, tracks how many bytes are saved.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A 1.2 GB upload finishes through 20 simulated network drops with no tap.
- **SC-002**: After a drop, the upload resends only what storage hadn't saved.
- **SC-003**: After a reload, picking the same file resumes within 5 seconds.
- **SC-004**: Picking a file whose sampled fingerprint differs always starts a new upload. None is refused for being a different file. A file that differs only between samples is treated as the same file (accepted limit).
- **SC-005**: On a stable connection, the upload takes no longer than today's single upload, within measurement noise.
- **SC-006**: Navigating within the app never stops the upload.

## Assumptions

- Testing is web-only for now (Playwright).
- The browser can't reopen a picked file after a reload, so a lost tab means picking the file again. The user chose this over copying the file into browser storage.
- How long a hidden tab keeps sending depends on the browser and device. The app can't extend it on the web.
- The pipeline still advances only from the open job page.
- The bucket's 7-day delete rule and the 7-day session life line up.
- The 15-minute and 2 GB caps, the song-title form, and the monitor playing the local file while it uploads are unchanged.
- The 002 model swap and the UI v2 guided release have merged. This feature builds on them: the pick happens on `/new`, and the upload is the release's first step.

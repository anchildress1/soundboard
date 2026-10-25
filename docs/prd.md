# 🎛️ Soundboard — Product Requirements

- **Status:** Draft v5 · 2026-10-16 (v2: sign-in and connections, spec `specs/001-google-sign-in`)
- **Owner:** Ashley Childress
- **User:** Nathan / Flies Like Robots (FLR), Virginia
- **Design:** [Soundboard mockup](https://claude.ai/artifact/QjNPi3sTJLiL437QA3FUpg)

## Problem

- Nathan is a musician. He makes the music and makes the videos for it.
- The work between "finished video" and "people can find it" stalls: titles, descriptions, tags, channel consistency, and a check that the upload is sound.

## Product

- A web app that watches and listens to a music video, grounds it in the most-viewed music videos for its genre, and smart-picks one YouTube title, description (with hashtags), and tag set.
- Nathan edits in place, re-runs the model, or approves. On approval it uploads the video as private and verifies it by reading it back.
- It learns from every edit, re-run, and approval.
- The model is Gemma 4 12B-it, open-weight under Apache 2.0, self-hosted on Ashley's GCP project. Nathan's audio stays there.

## Principles

- **One recommendation.** The AI does the thinking; Nathan reacts.
- **Grounded in the audience.** The genre search shows what reaches listeners. His channel supplies identity (name, credits, links), not the pattern to copy; its current metadata isn't reaching people.
- **Numbers come from ffmpeg.** The model gives perceptual judgment only.
- **Hashtags and tags come from a search.** The model picks from real candidates.
- **Verified means read back.**

## Goals

| #   | Goal                                                                     |
| --- | ------------------------------------------------------------------------ |
| G1  | Nathan gets a publish-ready recommendation by typing only the song title |
| G2  | Every upload is approved by Nathan and verified by read-back             |
| G3  | An invited artist signs in once with Google and uploads to their channel |

## Non-Goals

- Social posting, Bandcamp posting, website, email marketing, merch, content calendar. Bandcamp has no upload API for artist accounts and its editor refuses to be framed, so the app drafts Bandcamp copy and opens the editor instead (R4).
- Playlists.
- Lyrics transcription.
- Competitor research beyond the genre search (R4).
- Downloading videos from YouTube.
- Browser automation.
- Collaboration: a job belongs to one user.
- Per-artist voice, memory, and brand guide in this version; they come with spec 002.
- Third-party inference providers.

## Users

- **Nathan:** signs in with Google; uploads go to his channel. His account is linked to the FLR artist profile.
- **Ashley:** signs in with Google; uploads go to her own channel. Operates the app and reads the traces.
- **Anyone else:** not invited, turned away at sign-in.

## Requirements

### P0

**R1 · Upload**

- Video + song title (required) + notes. Browser PUTs straight to GCS via signed URL.
- Signed URL carries `x-goog-content-length-range: 1,2147483648` (2 GB). Bucket has CORS for the app origin and a 7-day delete rule.
- Job IDs are random and unguessable.
- [ ] Uploads up to 15 minutes are accepted; longer gets a clear message.
- [ ] A 12-minute video completes end to end.

**R2 · Video playback**

- The monitor plays the local file from an object URL the moment it's picked, while the upload runs.
- After upload, and on reloads, it streams from GCS through a signed GET URL; GCS serves range requests, so playback starts at once and seeking works.
- [ ] A 12-minute video plays and seeks in the monitor on a phone.

**R3 · Analysis**

- ffmpeg reads the source from GCS through a signed URL (range requests, nothing copied into RAM).
- Prep probes duration and the displayed video size (the file's rotation applied, since phones store portrait video as rotated landscape frames) and measures the whole file: LUFS, true peak, clipping, silence.
- A square or vertical video of 3 minutes or less adds a flag: YouTube publishes it as a Short.
- Each analyze step seeks to its own 29.5s window (under Gemma's 30s audio cap), extracts 8 frames at 360p + 16 kHz mono WAV in memory, and measures that window.
- One Gemma call per chunk: audio + frames + measurements + song title → visual, music, quality flags. Quality flags are unintended problems only; a deliberate glitch or distortion style is not one.
- Call settings: temperature 0.2, `max_tokens` ≥ 2048, JSON schema. Parse `content`; `reasoning_content` is the think block.
- When the model is scaled to zero (endpoint 429), loading (`/health` 503), or busy (`/slots` shows the slot taken), the step returns at once with a wait reason ("waking model", "waiting on another run") and the page calls again. Every step stays under about 2 minutes.
- [ ] Model-emitted dB/LUFS numbers are stripped.
- [ ] Per-chunk timeout 90s, counted after the model is up. A parse failure retries once, then keeps the raw text.
- [ ] Two consecutive chunk failures set `FAILED`; finished chunks stay visible. Loading and busy count as waits.
- [ ] Retry on a `FAILED` job resumes at the failed chunk.

**R4 · Smart pick**

- Chunk results + audience evidence + FLR's 3 most recent videos (identity only; 3 keeps the pick inside the model's 8K context) + Nathan's feedback → one `title, description, hashtags[], tags[], brandCheck`.
- `flags[]` are never the model's. The server builds them from ffmpeg's measurements, the Short notice, and the windows' own quality flags, each once. A free-form flag field let the model restate the video's look as problems.
- **Audience evidence (deterministic, one genre search):**
  - `search.list` for the chunk analysis's genre terms + "music video" (`type=video`, `videoCategoryId=10`, `order=viewCount`, `maxResults=50`, `videoDuration` bucket of the upload), then `videos.list` (`snippet,statistics,contentDetails`) for descriptions, tags, views, and length. One search page, with no pagination or refill.
  - Only results within 60 seconds of the upload's length count, so hour-long mixes and compilations never become evidence. Results with an unknown length never count.
  - Genre terms fold into the more specific heard genre that contains them ("electronic" into "industrial electronic") before the top two seed the query.
  - After length filtering, the first 10 eligible videos in YouTube's search order each supply their own candidate list, labeled with video ID and title. This caps prompt volume; fewer than 10 may qualify. Keep the lists separate; never merge, count, rank, or weight terms across videos or channels. View counts never enter candidate logic.
  - Each list contains that video's unique description `#hashtags` (at most 30) and unique tags plus description hashtag terms (at most 40), in first-seen order within the video.
  - The model may select terms from several lists. Approval checks membership in the union of the job's lists only.
  - Top videos: the first 5 eligible results in YouTube's search order. The title format and the description's structure and length are modeled on them; raw view counts never enter model prompts.
  - Research is stored separately in `job_audience` with its original retrieval time. All evidence reads use `job_audience_fresh`, whose database predicate excludes rows at least 30 days old; a daily Neon Function deletes expired rows even without app activity. Retries and Shorts never extend the retrieval time. Re-picking after expiry fetches fresh research.
  - After expiry, existing drafts retain only their selected tags and hashtags for approval validation; the full research pool is unavailable.
- FLR's recent uploads supply identity only: credit lines (his full name included) and how the artist is named. Their structure, tags, and hashtags are not copied.
- Every run reads as Nathan until spec 002 makes voice per artist: the description's wording follows Nathan's own writing voice, distilled from his YouTube descriptions and comments (2024 on) and written into the pick prompt: short and literal, his "hacked and slashed" credit line, dry self-mocking asides, no marketing copy, with spelling, capitalization, and grammar corrected (his slang, the styled song title, and the credited name stay as written). Structure and length still follow the audience evidence.
- The model picks 3–5 hashtags from the candidates; they close the description. Hashtags matching the chosen tags come first, so the description and the tags field agree.
- The description never opens with or repeats the title; YouTube shows the title right above it.
- `tags[]` (the YouTube tags field) come only from the tag candidates, plus the artist name. The model picks 5–10, each naming something the analysis heard (genre, subgenre, style, instrument); no mood, scene, or decade filler unless the analysis named it. The server keeps at most 10, always includes the artist name, and never fills from the pool: search membership alone doesn't show a tag was heard. Never the song title.
- `why` names the evidence behind each field.
- The same pick drafts Bandcamp copy in Nathan's voice: an About text and his credit and contact lines, cleaned like the description. After approval, the Bandcamp screen shows them with the song title and the pick's tags, each with a Copy button, and opens `flieslikerobots.bandcamp.com/edit_track` in a new tab.
- Thumbnails go to the model as base64 data URLs.
- Feedback weight: edits and approvals are strong; re-runs mean "not favorite," a weak signal.
- [ ] Every hashtag in the description and every tag is in the job's candidate lists.
- [ ] No tag contains the song title.
- [ ] Description links come from FACT or APPROVED records.
- [ ] YouTube limits hold: title ≤ 100, tags ≤ 500 total, description ≤ 5000.

**R5 · Review**

- One recommendation, reviewed one field at a time. Every field is editable. Actions: **Approve & upload**, **Re-run model**, **Discard**.
- Re-run model reruns smart pick only, with this job's skipped versions in the prompt.
- Approve holds edited tags to the same rules as the pick: the job's tag candidates or the artist name, never the song title.
- Discard ends the job; nothing is learned from it.
- [ ] The user linked to the artist profile stores edits, re-runs (as skips), and approvals in `artists/{id}/feedback`. Other users' feedback stays on the job.
- [ ] Each re-run produces a new title and a new description; a repeat of a skipped version is retried once, then fails the pick.

**R6 · Upload and verify**

- `videos.insert` as private (`madeForKids: false`), streamed from GCS as a resumable upload, then `videos.list(id)`.
- YouTube allows 100 uploads a day per GCP project, shared by all users, first come; a channel may have a lower cap of its own. The app keeps no count. When YouTube says either limit is reached, the job waits "Daily upload limit reached. Try tomorrow." and continues after the reset. More needs Google's YouTube API audit.
- Each upload uses its owner's own YouTube grant, so it lands on the owner's channel.
- Approval shows and records the exact destination YouTube channel ID and name with the approved fields. Publishing and verification use only the owner's grant verified for that channel.
- YouTube connects only the signed-in Google account, which has one channel, so a job's channel never changes.
- Persist the upload-start marker before the external initiation request; expired or cleared resumable sessions never clear it. Recovery checks the stored session for completion or a resumable offset. An expired session restarts on the same channel only if the final bytes were never sent. If they may have been sent, pause with "upload outcome unknown" and a link to the channel's uploads in YouTube Studio. The owner either pastes the video's URL, which the app accepts only after checking the video is on the pinned channel through the owner's grant, or discards. The app never searches for the video, and never uploads again on its own. A 401 means lost access, not an unknown outcome.
- Disconnecting or losing access pauses unfinished publishing and verification, preserving the job, approved fields and completed progress. Reconnecting the same channel resumes the next unfinished step without a duplicate upload. a request already in flight may finish against the original channel.
- Recovery preserves returned video IDs. An uncertain external outcome must be reconciled before retrying.
- Discarding a paused job stops future app steps; it does not delete a YouTube video or cancel an accepted external request. Keep any returned video ID and outcome.
- Search and catalog reads use an API key from a second GCP project, so they never spend upload quota.
- [ ] `VERIFIED` is set by the read-back.
- [ ] Reconnecting from a different Google account is rejected; a job's channel never changes.
- [ ] Disconnect and same-channel reconnect preserve publishing progress and resume upload or verification without a duplicate upload.

**R7 · Status**

- The status page drives the run: it calls the next step until the job reaches review.
- The home page lists only the signed-in user's jobs: the newest one in review up next, then running ones, then the rest, newest first, each with title, state and a continuation link. After reauthentication, users return home and reopen their interrupted job there.
- Resume depends on the seven-day media lifecycle. Missing media gets a clear new-upload requirement; saved metadata stays visible.
- [ ] "Window n of m" or a named wait ("Waking the model", "Waiting on another release") is always on screen.
- [ ] Reloading the page resumes from the next unfinished step.
- [ ] A step's claim on the job expires after 3 minutes, so an aborted request frees the job.

**R8 · Sign-in**

- Signed out, the home page shows sign-in; `/privacy` and `/terms` are public through the shared footer. Other app pages lead home and app data/mutation APIs return 401 without writes. `/auth/login`, `/auth/callback` and public static assets are explicit exceptions, tested independently; auth routes grant no app access until identity and invitation checks pass.
- One Google consent screen grants identity plus YouTube upload and read access, offline, so sign-in also connects the user's channel.
- While invite gating is enabled, only active invitations get a session; anyone else sees "not invited" and no session, user record or token is retained. One setting opens signup later; accounts that sign up while it's open stay on the allowlist until revoked.
- First redemption atomically binds a normalized invited email to the verified Google account ID. Later email changes preserve that binding; another account cannot claim the old email's invitation or artist link.
- A user is their stable Google account ID; email is for display and the allowlist.
- The session is a signed cookie with a fixed 30-day expiry and a unique browser session ID. Activity never extends expiry. Check access on every authenticated request; revoking denies old sessions on their next request. Reactivating lets unexpired sessions back in.
- The app refuses to be framed by any origin but its own.
- [ ] Every app page and data/mutation API refuses a signed-out request; enumerated auth and static-asset exceptions expose no app data.
- [ ] Two users signed in at once never see or upload each other's jobs.
- [ ] Interleaved A → B → A requests in one app process isolate headers, Connections, job lists, signed media URL issuance and all video/Short mutations on desktop Chrome and Pixel 7.

**R9 · Connections**

- One row per platform with its status and Connect, Reconnect, Disconnect. YouTube only for now; YouTube connects only the signed-in Google account; future platforms may use other accounts. Each user has one YouTube connection.
- Each user's YouTube refresh token is stored per user. A revoked or missing grant blocks approval with "reconnect YouTube" and doesn't fail the job.
- Connect and Reconnect bind to the initiating user, exact browser session, purpose and ten-minute expiry. Reject expired, replayed, superseded or mismatched callbacks and attempts after sign-out or session replacement; never change the sign-in identity. Failed or cancelled reconnect preserves the existing connection.
- Connected means both YouTube upload and read scopes, a usable long-lived grant and the selected channel's ID and name confirmed through that grant. Partial consent or no channel permits identity sign-in but blocks approval with an actionable status.
- Returning sign-in without a new refresh token preserves a valid existing matching grant. Validate replacement credentials before storing them; never erase a usable connection on an incomplete attempt.
- [ ] Same-channel Reconnect restores eligible work before upload initiation, during upload and before verification, preserving fields and progress without duplicate uploads.

**R10 · Access**

- Every job belongs to the user who made it; anyone else gets not-found.
- User-specific caches and credentials are isolated by user and, where needed, channel. Check ownership before issuing a signed media URL; already-issued URLs retain their bounded expiry after sign-out.
- Until spec 002, there's one artist profile (FLR). Only the user linked to it reads or writes its memory and recent-video identity, or opens the brand guide. Other users' picks run without artist memory or identity, and their feedback stays on the job.
- OAuth consent screen is set to **In production** before tokens are minted; Testing-mode refresh tokens expire after 7 days. The unverified-app screen stays until Google verifies the app: Advanced → Continue.
- Redirect URI is set to the deployed URL after the first deploy.
- The database has no client access: only the app (restricted pooled URL from Secret Manager), migrations, and the invite script (owner's direct URL, on the operator's machine) reach Neon. Refresh tokens are stored as Cloud KMS ciphertext, and only the app's service account can decrypt them.
- All five application tables enforce row-level security. The app connects as the non-owner `soundboard_app` role, which cannot bypass RLS; each short database transaction uses the verified Google `sub`, and missing identity denies access.
- Migrations and operator invites use separate privileged credentials. Account activation, artist assignment, and existing identity bindings cannot be changed by ordinary app queries; sign-in binds an account through a restricted database function.
- [x] A user's token and jobs are reachable only from that user's session.

**R11 · Sentry agent tracing**

- SDK: `@sentry/sveltekit` 11.4.0.
- One job = one trace. Job creation saves `sentry-trace` and `baggage` on the job doc. The status page renders them as `<meta>` tags, so the browser continues the job's trace and every step request carries it. Reloads land in the same trace.
- Each model call is an `invoke_agent` span (`chunk-analyst` or `smart-pick`) wrapping a `chat gemma-4-12b-it` span with provider `llama.cpp`, token counts, and messages ([Sentry AI agents spec](https://develop.sentry.dev/sdk/telemetry/traces/modules/ai-agents/)).
- The hashtag search is an `execute_tool hashtag_search` span inside `smart-pick`, with the query and candidate count.
- Audio and images are recorded as placeholders, keeping Nathan's audio out of Sentry.
- `tracesSampleRate: 1.0`, so every job's trace is complete.
- Release builds upload source maps under the commit's release: Cloud Build reads the upload token from Secret Manager as a BuildKit secret, so it never lands in an image layer. Local builds don't upload.
- [ ] A 12-minute job is one trace in Sentry, upload through verify.

### P1

**R12 · Brand guide** — reads up to 30 FLR videos + 10 thumbnails, proposes one brand statement with keep / fix / drop rules. Nathan approves it; smart pick uses it.

**R13 · Short**

- A vertical 15–60 s cut of the video's hook for YouTube Shorts, made on request once the video is approved. A video under 15 s can't make one. No video-generation model: every frame is Nathan's.
- The Short is its own job (`short` set, `parentId` → the video; the video holds `shortId`). It shares the video's trace, owner, channel, and candidate lists. One live Short per video.
- **hook:** one Gemma call (`invoke_agent hook-pick`), text only, over the video's chunk results and per-window ffmpeg loudness → `window, lengthSec, reason`. Re-pick sends the skipped hooks; a repeat retries once, then fails the step.
- **cut placement:** ffmpeg's momentary loudness across the window places the start on the biggest jump, backed up to the quietest moment in the second before it. No clear jump keeps the window start. A late window caps the length at what's left of the source from its start, so the cut starts inside the window; a window in the last 15 s gets the source's final 15 s.
- **render:** ffmpeg reads the source by signed URL, cuts, and fits to 1080×1920 (YouTube's Shorts frame), blur fill (default) or center crop, into a faststart MP4 in the container's temp dir. The file goes to its own GCS object, is deleted locally, and is read back with ffprobe before review.
- **Short screen:** offered once the video is approved. Short metadata starts from the video's approved fields, else its pick, under R4 and R5's rules. Nathan edits start, length, and framing (re-render, no model), re-picks the hook, approves, or discards the Short alone.
- Approve uploads through R6 (private, read-back verified) and counts against YouTube's daily upload limit. It records Nathan's edits as EDITED feedback but no ACCEPTED: the draft is the video's own metadata.
- [ ] Every hashtag and tag in an approved Short is in the video's candidate lists.
- [ ] A 60 s Short renders inside one step on the app container.
- [ ] A Short is `VERIFIED` only by read-back.

## System Design

One Cloud Run service for the app and one Vertex AI endpoint for the model, both in Ashley's project.

| Piece                                | Runs                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app` (Cloud Run, ingress)           | SvelteKit 2.70 + Svelte 5.57, ffmpeg                                                                                                                                                           |
| `model` (Vertex AI endpoint, one L4) | `llama-server` + Google's official Gemma 4 12B-it QAT Q4_0 GGUF + its mmproj, weights baked in and checksum-verified, port 8081 in the container; `/props` reports `vision: true, audio: true` |

- **App service:** 2 vCPU / 8 GiB, max 1, min 0, 60-min request timeout. No GPU.
- **Model endpoint:** a dedicated endpoint with one `g2-standard-4` replica (4 vCPU, 16 GiB, one L4), the same model image as a custom container. Invoke routes (`invokeRoutePrefix: "/*"`) pass `llama-server`'s own paths through, so the app calls `/v1/chat/completions`, `/health`, and `/slots` unchanged. The app authenticates with its service account ([custom container requirements](https://docs.cloud.google.com/vertex-ai/docs/predictions/custom-container-requirements)).
- **Scale to zero:** `minReplicaCount: 0`, `maxReplicaCount: 1`, idle scale-down and min scale-up periods at the 5-minute floor. A request to a scaled-down endpoint gets a 429 and starts a replica; the step maps it to "waking model". The feature is Preview, needs a dedicated (not shared public) endpoint, can stock out on scale-up, and undeploys a model idle for 30 days ([autoscaling](https://docs.cloud.google.com/vertex-ai/docs/predictions/autoscaling)).
- **Why Vertex:** Cloud Run's L4 quota for the project is 0 and two increase requests were denied. Vertex's L4 serving quota in us-central1 is 2 without a request. Audio still never leaves the project.
- **Cost:** about $0.81/hr while a model replica is up (`g2-standard-4` online inference, L4 included), billed for at least 5 minutes per wake. The app bills only while serving. $0 when nobody visits.
- **Storage:** one GCS bucket, `uploads/`.
- **State:** Neon Postgres through Drizzle; SQL migrations in `drizzle/` run before each deploy moves traffic. **Secrets:** Secret Manager. **Refresh tokens:** Cloud KMS key `soundboard/refresh-tokens`.
- **Region:** us-central1 for everything on Google Cloud. The database is the one exception: Neon runs in `aws-us-east-2`.
- **Pipeline:** runs in the app container while Nathan watches. The status page calls `POST /api/jobs/{id}/step`; each call does one step and returns the job.
  - **prep:** probe and measure the whole file.
  - **analyze:** cut and analyze one 29.5s window per call.
  - **pick:** hashtag search, then smart pick → job to `REVIEW`.
  - **hook** (Short jobs): pick the hook window, place the cut from loudness.
  - **render** (Short jobs): cut and reframe to 9:16 into GCS → job to `REVIEW`.
- Each step claims the job with one conditional update that sets a random claim token and a 3-minute expiry, so a second tab waits instead of double-running. A step's result is saved only while its token still holds the claim.

### Postgres

| Table           | Holds                                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`         | the allowlist and the accounts: invited email, Google account ID bound at first sign-in, artist profile link, active flag                                                                                                                                                                                   |
| `connections`   | one row per user: YouTube grant status, channel ID and name, scopes, KMS-encrypted refresh token                                                                                                                                                                                                            |
| `jobs`          | owner (`ownerUid`), approved destination channel ID/name, state, claim token and expiry, upload progress, video ID; the rest (trace headers, hashtag candidates, Short fields) as JSON; step results as `picks` and `chunks` arrays, and `feedback` on jobs not tied to an artist profile                   |
| `artist_memory` | per artist, by kind: facts (FACT · INFERENCE · APPROVED; seeds: name and Virginia as FACT, the "Mr. Kill" connection as INFERENCE, kept out of public copy), feedback (EDITED · SKIPPED · ACCEPTED), publishes (video ID, URL, final metadata, status), and the brand guide's proposal and approved version |

## UX

Built from the [Soundboard v2 boards](https://claude.ai/artifact/2u71AaL5GMC2fmWvnwQgaf), adapted to what the app can actually back. Dark only.

- **One release, one path:** a release is eight steps: Upload, Listening, Title, Description, Tags, Check, Approve, Upload & verify. Each screen asks one question and has one primary button. A bar on top shows "Step n of 8 · Name", an eight-segment rail, and Back to releases, plus Save & leave from Listening through Upload & verify, once there is something saved to come back to.
- **Working screens:** while the app works, the screen says what it's doing in one headline and one plain line (window n of m, or the named wait), and that leaving is safe once the browser upload is done. The video monitor (R2), the state with its progress bar and model label, and "What the model heard" sit below.
- **Guided review (R5):** Title, then Description, then Tags, each with its live counter and the pick's "Why this". Check appears only when ffmpeg flagged something. Approve shows a summary (title, description length and hashtags, tags, destination channel, Private) with Back, Discard, and Approve & upload; the field screens carry Re-run model. A field the server rejects sends Nathan back to that field. Approve still sends every field at once.
- **Edits survive leaving:** unsaved review edits and the current step stay in the browser per job and pick version, and clear on approval.
- **Up next, after approval:** once the YouTube upload is approved, the release offers Make a Short from the hook (R13) and Put it on Bandcamp (R4's copy fields). Each opens as its own screen with a way back. A video under 15 s says why it can't make a Short.
- **New release:** its own page: pick the finished video, the song title, and optional notes, then Start the release.
- **Home, signed out:** "Sign in to Soundboard" and one Continue with Google button. A "not invited" or "sign-in expired" notice shows above it.
- **Home, signed in:** the newest release that needs review sits on top as Up next with one Continue button. Running releases follow with "nothing to do yet" and a Watch link. Everything else is under Earlier with its state. New release is the primary action only when nothing is up next. No releases yet: a short explanation of the loop and Start.
- **Header:** the wordmark, the connected channel's handle with its exact video and subscriber counts (on its own row on phones), and a Menu: Connections, Brand guide and Settings (artist-linked user only), and Sign out.
- **Connections:** YouTube with Connected as … / Not connected and Connect, Reconnect, Disconnect. Bandcamp is listed as copy and paste with nothing to connect; Instagram and TikTok as coming later, with no controls.
- **Settings:** Peer influence lists the five roles and the source each uses by default. No sliders until fanbase learning ships (spec 006).
- **Not found / errors:** the status, a plain explanation, and a link home.
- **Footer:** artist and Ashley credits and the license, text links to Ashley's site and socials, and the Terms of Service and Privacy policy.
- **Phones (primary):** one column. On review screens the actions pin to the bottom, primary first and full width.
- **Color:** one palette in `src/lib/styles/tokens.css`, the only file allowed color values: primitives first, then semantic names (`--ground`, `--panel`, `--well`, `--ink`, `--muted`, `--action`, `--attention`, `--ok`, `--warn`, `--err`). Components use semantic names only; Stylelint rejects a color literal anywhere else and any undeclared token.
- **Accents have one job each:** cyan for actions, links, focus, and running work; magenta only for what needs Nathan; green verified, amber warnings, red errors. The cyan-to-magenta Signal Line marks the brand and the current step. Control borders meet 3:1 contrast.
- **States:** running, needs review, verified ("Verified · private" with the video link), failed, and discarded, each as a colored dot or chip with its text.
- **Type:** Bricolage Grotesque for headings and the wordmark, Onest for everything else, numbers in tabular figures.
- **Motion:** state changes only, off under `prefers-reduced-motion`.
- **Board copy the build replaces:** peer statistics such as average title length (no numbers derived from YouTube statistics, per the API terms), the brand thumbnail strip, sample peer artists, working influence sliders, the error page's trace ID, and an Instagram/TikTok connect button.

## Success Metrics

| Metric                                              | Target  |
| --------------------------------------------------- | ------- |
| Warm 30s video, upload → recommendation             | ≤ 2 min |
| Uploads verified by read-back                       | 100%    |
| Real FLR releases through Soundboard, two weeks out | ≥ 1     |

## Open Questions (Ashley)

- OAuth app verification for `youtube.upload` before open signup.
- Second GCP project for the read-only YouTube API key.
- Sentry DSN / org.

## License

PolyForm Noncommercial 1.0.0 (source-available). Releases through v1.0.0 stay MIT.

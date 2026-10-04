# 🎛️ Soundboard — Product Requirements

- **Status:** Draft v4 · 2026-10-03
- **Owner:** Ashley Childress
- **User:** Nathan / Flies Like Robots (FLR), Virginia
- **Deadline:** 2026-10-05 06:59 UTC — DEV Hacktoberfest Weekend Challenge: Build for a Friend
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
| G3  | Anyone can run the real app inside the DEV post, signed out, on a phone  |
| G4  | The diff view shows what Soundboard would improve on a live FLR video    |

## Non-Goals

- Social posting, Bandcamp posting, website, email marketing, merch, content calendar. Bandcamp has no upload API for artist accounts and its editor refuses to be framed, so the app drafts Bandcamp copy and opens the editor instead (R4).
- Playlists.
- Lyrics transcription.
- Competitor research beyond the genre search (R4).
- Downloading videos from YouTube.
- Browser automation.
- Multi-artist or collaboration.
- Third-party inference providers.

## Users

- **Nathan:** signs in with Google; uploads go to his channel.
- **Visitor (judge or anyone):** signed out, often in the dev.to iframe.
- **Ashley:** operates it and reads the traces.

## Requirements

### P0

**R1 · Upload**

- Video + song title (required) + notes. Browser PUTs straight to GCS via signed URL.
- Signed URL carries `x-goog-content-length-range: 1,2147483648` (2 GB). Bucket has CORS for the app origin and a 7-day delete rule.
- Job IDs are random and unguessable.
- [ ] Nathan's uploads up to 15 minutes and visitor uploads up to 5 minutes are accepted; longer gets a clear message.
- [ ] A 12-minute video completes end to end.

**R2 · Video playback**

- The monitor plays the local file from an object URL the moment it's picked, while the upload runs.
- After upload, and for samples and reloads, it streams from GCS through a signed GET URL; GCS serves range requests, so playback starts at once and seeking works.
- [ ] A 12-minute video plays and seeks in the monitor on a phone inside the dev.to iframe.

**R3 · Analysis**

- ffmpeg reads the source from GCS through a signed URL (range requests, nothing copied into RAM).
- Prep probes duration and measures the whole file: LUFS, true peak, clipping, silence.
- Each analyze step seeks to its own 29.5s window (under Gemma's 30s audio cap), extracts 8 frames at 360p + 16 kHz mono WAV in memory, and measures that window.
- One Gemma call per chunk: audio + frames + measurements + song title → visual, music, quality flags.
- Call settings: temperature 0.2, `max_tokens` ≥ 2048, JSON schema. Parse `content`; `reasoning_content` is the think block.
- When the model is loading (`/health` 503) or busy (`/slots` shows the slot taken), the step returns at once with a wait reason ("waking model", "waiting on another run") and the page calls again. Every step stays under about 2 minutes.
- [ ] Model-emitted dB/LUFS numbers are stripped.
- [ ] Per-chunk timeout 90s, counted after the model is up. A parse failure retries once, then keeps the raw text.
- [ ] Two consecutive chunk failures set `FAILED`; finished chunks stay visible. Loading and busy count as waits.
- [ ] Retry on a `FAILED` job resumes at the failed chunk.

**R4 · Smart pick**

- Chunk results + audience evidence + FLR's 3 most recent videos (identity only; 3 keeps the pick inside the model's 8K context) + Nathan's feedback → one `title, description, hashtags[], tags[], flags[], brandCheck`.
- **Audience evidence (deterministic, one genre search):**
  - `search.list` for the chunk analysis's genre terms + "music video" (`type=video`, `videoCategoryId=10`, top 50, `videoDuration` bucket of the upload), then `videos.list` (`snippet,statistics,contentDetails`) for descriptions, tags, views, and length.
  - Only results within 60 seconds of the upload's length count, so hour-long mixes and compilations never become evidence. Results with an unknown length never count, and a sample's own live video is left out.
  - Genre terms fold into the more specific heard genre that contains them ("electronic" into "industrial electronic") before the top two seed the query.
  - Hashtag candidates: every `#hashtag` in those descriptions, ranked by frequency; top 30.
  - Tag candidates: their tags and description hashtags, ranked by how many videos use them, then by those videos' views; top 40.
  - Top videos: the 5 most-viewed results. The title format and the description's structure and length are modeled on them.
  - Stored on the job, so re-runs reuse it.
- FLR's recent uploads supply identity only: credit lines (his full name included) and how the artist is named. Their structure, tags, and hashtags are not copied.
- Every run reads as Nathan, the signed-out demo included: the description's wording follows Nathan's own writing voice, distilled from his YouTube descriptions and comments (2024 on) and written into the pick prompt: short and literal, his "hacked and slashed" credit line, dry self-mocking asides, no marketing copy, with spelling, capitalization, and grammar corrected (his slang, the styled song title, and the credited name stay as written). Structure and length still follow the audience evidence.
- The model picks 3–5 hashtags from the candidates; they close the description. Hashtags matching the chosen tags come first, so the description and the tags field agree.
- The description never opens with or repeats the title; YouTube shows the title right above it.
- `tags[]` (the YouTube tags field) come only from the tag candidates, plus the artist name. The model picks 5–10, each naming something the analysis heard (genre, subgenre, style, instrument); no mood, scene, or decade filler unless the analysis named it. The server keeps at most 10, always includes the artist name, and never fills from the pool: search membership alone doesn't show a tag was heard. Never the song title.
- `why` names the evidence behind each field.
- The same pick drafts Bandcamp copy in Nathan's voice: an About text and his credit and contact lines, cleaned like the description. The review screen shows them with the song title and the pick's tags, each with a Copy button, and opens `flieslikerobots.bandcamp.com/edit_track` in a new tab.
- For a sample, its own live video is excluded from the 5, so the proposal can't copy the metadata it's compared against.
- Thumbnails go to the model as base64 data URLs.
- Feedback weight: edits and approvals are strong; re-runs mean "not favorite," a weak signal.
- [ ] Every hashtag in the description and every tag is in the job's candidate lists.
- [ ] No tag contains the song title.
- [ ] Description links come from FACT or APPROVED records.
- [ ] YouTube limits hold: title ≤ 100, tags ≤ 500 total, description ≤ 5000.

**R5 · Review**

- One recommendation. Every field is editable in place. Actions: **Approve & upload**, **Re-run model**, **Discard**.
- Re-run model reruns smart pick only, with this job's skipped versions in the prompt.
- Approve holds edited tags to the same rules as the pick: the job's tag candidates or the artist name, never the song title.
- Discard ends the job; nothing is learned from it.
- [ ] Allowlisted sessions store edits, re-runs (as skips), and approvals in `artists/{id}/feedback`. Visitor feedback stays on the job.
- [ ] Each re-run produces a new title and a new description; a repeat of a skipped version is retried once, then fails the pick.

**R6 · Upload and verify**

- `videos.insert` as private (`madeForKids: false`), streamed from GCS as a resumable upload, then `videos.list(id)`.
- Upload quota fits 6 uploads a day: visitors get at most 4, leaving 2 for Nathan.
- Search and catalog reads use an API key from a second GCP project, so they never spend upload quota.
- [ ] `VERIFIED` is set by the read-back.

**R7 · Status**

- The status page drives the run: it calls the next step until the job reaches review.
- [ ] Chunk N/M or a named wait ("waking model", "waiting on another run") is always on screen.
- [ ] Reloading the page resumes from the next unfinished step.
- [ ] A step's claim on the job expires after 3 minutes, so an aborted request frees the job.

**R8 · Public home page**

- The home page is the app. Signed out: zero cookies, 30-second FLR samples cut from the strongest part of each song (one tap) plus own-video upload.
- Signed-out samples upload to Ashley's throwaway channel. Signed-out own-video runs end at the would-be payload and read as Nathan, with his name and credits.
- Caps: 40 runs/day, 5 per IP. When upload quota is spent, runs end at the would-be payload.
- DEV embeds Cloud Run through `{% embed https://<service>.run.app %}` and nothing else from an arbitrary domain, so the post uses the default `run.app` URL ([DEV editor guide](https://dev.to/p/editor_guide)).
- [ ] Embeds in a DEV draft with `frame-ancestors 'self' https://dev.to https://*.dev.to` and completes a sample run on a phone.

**R9 · Reupload diff**

- [ ] Each sample shows current vs proposed metadata for its live video, field by field, with a reason.

**R10 · Auth**

- Google sign-in with an allowlist (Nathan, Ashley) targets Nathan's channel. YouTube refresh tokens live in Secret Manager.
- Demo accounts (`DEMO_EMAILS`) sign in and run like Nathan: 15-minute videos, no visitor caps, picks that read his memory. They never write it: feedback stays on the job, nothing lands in `artists/*`. Approvals upload private to the sandbox channel on the visitor quota. No brand guide, channel connect, or access to Nathan's jobs. A "Demo account" banner under the header says so on every page.
- Any other Google account is turned away with a notice and stays signed out.
- OAuth consent screen is set to **In production** before tokens are minted; Testing-mode refresh tokens expire after 7 days. The unverified-app screen stays: Advanced → Continue (tell Nathan).
- Redirect URI is set to the deployed URL after the first deploy.
- Firestore security rules deny all client access; only the app's service account reads and writes.
- [ ] Nathan's token and Nathan's jobs are reachable only from an allowlisted session.

**R11 · Sentry agent tracing**

- SDK: `@sentry/sveltekit` 11.4.0.
- One job = one trace. Job creation saves `sentry-trace` and `baggage` on the job doc. The status page renders them as `<meta>` tags, so the browser continues the job's trace and every step request carries it. Reloads land in the same trace.
- Each model call is an `invoke_agent` span (`chunk-analyst` or `smart-pick`) wrapping a `chat gemma-4-12b-it` span with provider `llama.cpp`, token counts, and messages ([Sentry AI agents spec](https://develop.sentry.dev/sdk/telemetry/traces/modules/ai-agents/)).
- The hashtag search is an `execute_tool hashtag_search` span inside `smart-pick`, with the query and candidate count.
- Audio and images are recorded as placeholders, keeping Nathan's audio out of Sentry.
- `tracesSampleRate: 1.0`, so every job's trace is complete.
- Release builds upload source maps under the commit's release: Cloud Build reads the upload token from Secret Manager as a BuildKit secret, so it never lands in an image layer. Local builds don't upload.
- [ ] A 12-minute job is one trace in Sentry, upload through verify.
- [ ] Screenshots for the post: a full trace and a failed run.

### P1

**R12 · Brand guide** — reads up to 30 FLR videos + 10 thumbnails, proposes one brand statement with keep / fix / drop rules. Nathan approves it; smart pick uses it.

## System Design

One Cloud Run service with an L4 GPU, two containers sharing `localhost`.

| Container                        | Runs                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app` (ingress)                  | SvelteKit 2.70 + Svelte 5.57, ffmpeg                                                                                                                                                                   |
| `model` (sidecar, holds the GPU) | `llama-server` + Google's official Gemma 4 12B-it QAT Q4_0 GGUF + its mmproj, weights baked in and checksum-verified, port 8081 inside the instance only; `/props` reports `vision: true, audio: true` |

- **Service:** model container 4 vCPU / 16 GiB (the L4 minimum) + app container 2 vCPU / 8 GiB, max 1, min 0, instance-based billing (required for GPUs), 60-min request timeout. Cloud Run gives the GPU to one container per instance ([GPU support for services](https://docs.cloud.google.com/run/docs/configuring/services/gpu)).
- **Startup:** the `model` sidecar's startup probe is a TCP check, so the page serves within seconds while weights load; `/health` drives "waking model".
- **Why one service:** both pieces live and die with the single instance anyway. One service drops the service-to-service IAM token, the second deploy, and Cloud Run's 429s; `llama-server` queues requests itself.
- **Cost:** any visit wakes the GPU instance and bills it until it idles out (up to ~15 min). $0 when nobody visits. Scale by raising max instances.
- **Storage:** one GCS bucket, `uploads/`.
- **State:** Firestore. **Secrets:** Secret Manager.
- **Region:** us-central1 for everything. Firestore is created there; its location is permanent.
- **Pipeline:** runs in the app container while Nathan watches. The status page calls `POST /api/jobs/{id}/step`; each call does one step and returns the job.
  - **prep:** probe and measure the whole file.
  - **analyze:** cut and analyze one 29.5s window per call.
  - **pick:** hashtag search, then smart pick → job to `REVIEW`.
- Each step claims the job in a Firestore transaction with a 3-minute expiry, so a second tab waits instead of double-running.

### Firestore

| Path                                     | Holds                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs/{id}`                              | state, chunk progress, trace headers, hashtag candidates                                                                                                                              |
| `jobs/{id}/chunks/{n}`, `jobs/{id}/pick` | step results                                                                                                                                                                          |
| `artists/{id}/facts`                     | FACT (Nathan said it) · INFERENCE (model's guess) · APPROVED (Nathan approved it). Seeds: name and Virginia as FACT; the "Mr. Kill" connection as INFERENCE, kept out of public copy. |
| `artists/{id}/feedback`                  | EDITED · SKIPPED · ACCEPTED                                                                                                                                                           |
| `artists/{id}/publishes`                 | video ID, URL, final metadata, status                                                                                                                                                 |

## UX

Built from the [Soundboard mockup](https://claude.ai/artifact/QjNPi3sTJLiL437QA3FUpg). One screen, dark only.

- **Frame:** true-black letterbox, a VHS smear strip across the top (blue / orange / magenta), the Mr Dafoe "Soundboard" wordmark in neon magenta, and, for Nathan, the FLR channel stats from `channels.list` top right.
- **Left pane, the tape:**
  - Video monitor (R2), with filename, resolution, and timecode overlays.
  - State chip + magenta progress bar + model label (`gemma-4-12b-it · 52s`, total model time for the job; it ticks live while the pick runs).
  - "What the model heard": perceptual tags from the chunk analysis (genre, tempo feel, instrumentation). Vocals is a free-text description, not a tag.
- **Right pane: one tab per destination,** each marked done (green ✓) or to do (yellow ●).
  - Above both tabs, "Check before uploading" lists the flags as a warning (⚠, yellow outline), since an audio or video problem matters wherever the song goes.
  - **YouTube** (done once verified): the title as a plain field with a live `n / 100` counter, the description ("model draft", ending in the picked hashtags), tags in mono with a live `n / 500` counter (Approve disables past 500), and Visibility fixed at **Private**. Actions sit together: Discard, Re-run model, Approve & upload (magenta, offset shadow).
  - **Bandcamp** (done once every field is copied): track name, About, credits, and tags with a Copy button each, and Bandcamp's new-track page opened in its own window.
  - The brand check stays in the pick for tracing but isn't shown: it's the model grading itself, not something Nathan acts on.
- **Under 820px:** one column: the video, its status, and "What the model heard", then the tabs. The actions stack as one block, Approve first.
- **Motion:** light and decorative only: the smear's gaps drift like VHS tracking, the wordmark flickers on once, sections rise in on load, tag chips pop in. All of it is off under `prefers-reduced-motion`.
- **Header:** one aligned row. Signed out: Sign in. Allowlisted: the channel handle and video and subscriber counts, Brand guide, and Sign out. Signed out, the stats would read as a signed-in account, so they're hidden. A denied sign-in or a connected channel shows a notice under the header. Channel connect links live on the Brand guide page.
- **Footer:** one quiet row: credits, then icon links to Ashley's site and socials. Neutral colors only.
- **Accents have one job each:** magenta for the wordmark, primary actions, and focus; orange for panel labels; blue for the smear and info states. Header and footer chrome stays neutral.
- **Not found / errors:** a page under the same frame with the status, a plain explanation, and a link home.
- **States:** info `#7fb2ff`, needs review `--yellow`, verified `--green`, failed `--red-text`. Verified reads "Verified · private" with the video link.
- **Tokens:** `--ground #0a0a0a`, `--panel #171615`, `--well #242321`, `--line #6e6a64`, `--ink #f4f1ea`, `--muted #b3ada3`, `--magenta #ff4fd8`, `--orange #ff7a1a`, `--yellow #ffd23f`, `--blue #2e8cff` (neon), `--green #6fdc5a`, `--red #d8281a`, `--red-text #ff6a52`.
- **Type:** Mr Dafoe wordmark, Rubik 700/900 labels and buttons, Inter body, JetBrains Mono for tags, counters, and metadata.
- **Mockup copy that the build replaces:** hashtags in the tags field (they move to the description; tags are plain terms), "118 bpm" and lyric fragments in "What the model heard" (numbers come from ffmpeg; lyrics are a non-goal), "last 10 uploads" (the grounding is the genre search), the Public/Scheduled/Unlisted options, the Playlist picker, and "Live on YouTube".

## Success Metrics

| Metric                                                 | Target  |
| ------------------------------------------------------ | ------- |
| Sample runs completing in the dev.to iframe on a phone | All     |
| Warm 30s sample, upload → recommendation               | ≤ 2 min |
| Uploads verified by read-back                          | 100%    |
| Real FLR releases through Soundboard, two weeks out    | ≥ 1     |

## Open Questions (Ashley)

- Source FLR videos for the samples + their `videoId`s.
- Throwaway YouTube channel, added as an OAuth test user with Nathan and Ashley.
- Second GCP project for the read-only YouTube API key.
- Sentry DSN / org.
- Nathan's OK on his songs playing as public samples.

## Timeline

| When (EDT)      | Milestone                                                           |
| --------------- | ------------------------------------------------------------------- |
| Sat night       | Repo, OAuth consent, throwaway channel, GPU service up, upload path |
| Sun 08:00–13:00 | P0, then brand guide                                                |
| Sun 13:00       | Freeze                                                              |
| Sun 14:00–17:00 | Walkthrough recording, post                                         |
| **Sun 17:00**   | **Publish**                                                         |
| Mon 02:59       | Deadline                                                            |

- **Cut-off timers:** model audio + images 90 min (fallback: frames + ffmpeg only) · Sentry 20 min (fallback: Cloud Trace) · anything else 15 min.
- **Categories:** Gemma, Sentry Agent Tracing.
- **License:** MIT.

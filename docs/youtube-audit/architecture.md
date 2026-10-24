# YouTube audit architecture

## Current implementation

This describes the repository implementation, not confirmation that every component is deployed.

```mermaid
%%{init: {"theme": "default"}}%%
flowchart TB
  accTitle: Soundboard current architecture
  accDescr: An artist signs in with Google and uploads media directly to Cloud Storage. The browser drives one pipeline step per request to a Cloud Run app. The app runs ffmpeg, invokes self-hosted Gemma on Vertex AI, stores state in Neon, reads public YouTube data with an API key, and uploads approved videos using the artist's OAuth grant. KMS encrypts refresh tokens. Research expires through a database view and a daily cleanup function.

  USER["Artist's browser<br/>Review, edit, approve and resume"]
  AUTH["Google OAuth<br/>Identity and YouTube consent"]
  DB[("Neon Postgres<br/>Users, connections, jobs and artist memory<br/>Research with retrieval timestamps")]
  YT["YouTube Data API"]
  SENTRY["Sentry<br/>Errors and text traces<br/>Prompts include YouTube metadata (until spec 002)<br/>No audio or image bytes"]
  YTIMG["YouTube thumbnail images<br/>i.ytimg.com"]

  subgraph GCP["Google Cloud project"]
    APP["Cloud Run: SvelteKit and ffmpeg<br/>One app instance; no GPU<br/>One claimed pipeline step per request"]
    MEDIA[("Cloud Storage<br/>Source videos and rendered Shorts<br/>7-day media lifecycle")]
    MODEL["Vertex AI dedicated endpoint<br/>llama-server and Gemma<br/>One L4 replica; scale to zero"]
    KMS["Cloud KMS<br/>Encrypt and decrypt refresh tokens"]
    SECRETS["Secret Manager<br/>Server credentials"]
  end

  USER <-->|"Sign in and consent"| AUTH
  AUTH -->|"Validated callback"| APP
  APP -->|"Revoke grant on disconnect"| AUTH
  USER -->|"Signed media upload"| MEDIA
  USER <-->|"Job requests and status"| APP
  APP <-->|"Signed media reads; rendered Short writes"| MEDIA
  APP <-->|"Audio, frames, text and thumbnails; model results"| MODEL
  YTIMG -->|"Thumbnails for smart pick and brand guide"| APP
  APP <-->|"Owner-scoped state; encrypted tokens"| DB
  APP <-->|"Token encryption"| KMS
  SECRETS -->|"Credentials"| APP
  APP <-->|"API key: search.list and videos.list (genre research);<br/>playlistItems.list and videos.list (artist's recent uploads);<br/>channels.list (uploads playlist; header stats, memory only)"| YT
  APP <-->|"Own channel and uploads: channels.list,<br/>videos.insert, videos.list; artist OAuth"| YT
  APP -->|"Traces: media bytes and URL credentials removed"| SENTRY
  USER -->|"Browser errors and traces"| SENTRY

  FRESH["job_audience_fresh view<br/>Research readable only while under 30 days old"]
  CLEAN["Daily Neon cleanup function<br/>03:00 UTC on the production branch"]
  DB --> FRESH
  FRESH -->|"All research reads"| APP
  CLEAN -.->|"Delete expired research"| DB
```

- Each source video supplies a separate candidate list; terms are unique within that video.
- Research terms are never counted or weighted across videos or channels; raw view counts do not enter model prompts.
- Uploads use the approving artist's pinned channel and remain private; only API read-back marks them verified.
- Model-call traces currently record full prompt text, which includes YouTube titles, descriptions and tags. Media bytes and URL credentials are removed. Spec 002 replaces YouTube-sourced text in traces with placeholders.
- Thumbnails are fetched from YouTube's image host only for smart pick and the brand guide, sent to the model, and not stored.
- Header channel stats are cached in memory only and never written to the database.
- The daily cleanup function runs at 03:00 UTC on the production database branch, deployed on 2026-10-24. It rejects any call that doesn't come from Neon's scheduler and can only delete research that is already past 30 days.

## Planned model provider: Gemini API (spec 002)

Not implemented. Replaces the self-hosted Gemma endpoint.

```mermaid
%%{init: {"theme": "default"}}%%
flowchart LR
  accTitle: Planned Gemini API data flow
  accDescr: For each analysis window, the app cuts a small video clip from Cloud Storage and sends it to the Gemini API. For the smart pick, it sends song analysis, the artist's own recent uploads and separate genre-research candidate lists. Requests set store false. Google keeps prompts and responses up to 55 days for abuse monitoring only. Sentry records YouTube-sourced text as placeholders.

  CLIP["One window clip<br/>360p, cut by ffmpeg, temporary file"] --> GEMINI["Gemini API<br/>Paid tier; store: false"]
  PROMPT["Pick prompt<br/>Song analysis, artist's own uploads,<br/>separate candidate lists, thumbnails"] --> GEMINI
  GEMINI --> DRAFT["Draft for the artist's review"]
  GEMINI -.->|"Abuse-monitoring log, up to 55 days;<br/>not used for training"| GOOGLE["Google"]
  DRAFT --> TRACE["Sentry trace<br/>YouTube-sourced text as placeholders"]
```

- YouTube API data is used per call only. The app requests no provider storage, caching, file uploads or grounding.
- The artist's own channel data serves only that artist's requests.
- The privacy policy names the Gemini API as a processor when this ships.

## Planned fanbase learning — spec 006

These stages are not implemented; calculated metrics and subscriber-range targeting remain disabled until YouTube accepts the amendment.

```mermaid
%%{init: {"theme": "default"}}%%
flowchart LR
  accTitle: Planned Soundboard fanbase-learning data flow
  accDescr: A pipeline run starts server-side research using free public YouTube data and optional authorized analytics for the artist's own channel. Relevant individual peer releases and the artist's outcomes inform a recommendation according to saved influence settings. The artist reviews and approves the result. A later pipeline run reads outcomes to inform future recommendations. Calculated metrics require YouTube approval.

  RUN["Pipeline run"] --> RESEARCH["Server-side research<br/>Continues without the browser"]
  PUBLIC["YouTube Data API<br/>Individual comparable artist releases"] --> RESEARCH
  OWN["YouTube Analytics API<br/>reports.query<br/>Own channel; optional artist consent"] --> RESEARCH
  RESEARCH --> PICK["Recommendation<br/>Song analysis, artist history and peer evidence"]
  SETTINGS["Artist's saved influence sliders"] --> PICK
  PICK --> REVIEW["Artist review and approval"]
  REVIEW --> PUBLISH["Existing private upload<br/>and verification flow"]
  RUN --> LEARN["Server-side learning<br/>Read prior release outcomes"]
  OWN --> LEARN
  PUBLISH -->|"Published metadata and video ID"| LEARN
  LEARN -->|"Evidence for later runs"| PICK
```

- Peer releases stay individually labeled; no cross-owner totals or combined performance score.
- Reported statistics retain retrieval times and database-enforced 30-day expiry.
- Views indicate reach; only the artist's authorized subscriber gains and losses measure fanbase change.

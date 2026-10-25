# YouTube audit architecture

## Current implementation

This describes the repository implementation, not confirmation that every component is deployed.

```mermaid
%%{init: {"theme": "default"}}%%
flowchart LR
  accTitle: Soundboard current architecture
  accDescr: The artist uses a browser to sign in through Google and drive the Cloud Run app. Media goes directly to Cloud Storage. The app sends window clips and text to the paid Gemini API for analysis and drafting. It uses Neon for state and YouTube for research and approved private uploads. Cloud KMS and Secret Manager protect credentials. Sentry keeps text traces for 30 days. Neon deletes expired research daily.

  ARTIST["Artist's browser"] <-->|"Sign in and consent"| AUTH["Google OAuth"]
  ARTIST <-->|"Review and approve"| APP["Soundboard<br/>Cloud Run · SvelteKit · ffmpeg"]
  AUTH <-->|"Validate grant / revoke"| APP
  ARTIST -->|"Direct media upload"| MEDIA[("Cloud Storage<br/>7-day media lifecycle")]
  APP <-->|"Read media / write Shorts"| MEDIA
  APP <-->|"Window clips and text · API key"| MODEL["Gemini API · paid tier<br/>Implicit cache · 55-day abuse log"]
  APP <-->|"Save progress and evidence"| DB[("Neon Postgres<br/>30-day research expiry<br/>Daily deletion")]
  APP <-->|"Research / approved private uploads"| YT["YouTube Data API<br/>and thumbnail host"]
  APP --- SECURITY["Cloud KMS + Secret Manager<br/>Protected credentials"]
  APP -->|"Text traces"| SENTRY["Sentry<br/>30-day retention"]
```

- Public research uses an API key; own-channel confirmation and uploads use the artist's OAuth grant.
- Each source video supplies a separate candidate list; terms are unique within that video.
- Research terms are never counted or weighted across videos or channels; raw view counts do not enter model prompts.
- Uploads use the approving artist's pinned channel and remain private; only API read-back marks them verified.
- Gemini receives each analysis window as a clip of at most 640×360 and 8,000,000 bytes, sent inline and never as a link, plus song details, notes and YouTube metadata. Calls use the paid tier, so Google doesn't use the content to improve its products.
- Every call sets `store: false`, which turns off stored interaction history only. Gemini may also cache parts of a request automatically; Google publishes no expiry for those copies. Separately, Google keeps requests and responses up to 55 days for abuse monitoring, where authorized staff may review flagged requests. A deletion request to Soundboard can't reach either copy.
- Model-call traces record full prompt, reply and reasoning text for every agent, including YouTube titles, descriptions and tags. Sentry keeps them for 30 days on the Developer plan. Media bytes are replaced with placeholders and URL credentials are removed. Voice and brand guide replies are recorded only as their length, and the uploads sent to them only as a count.
- Approval gate: the Gemini version isn't deployed until YouTube approves the request covering this Gemini processing and storage and the Sentry text retention.
- Thumbnails are fetched from YouTube's image host only for smart pick and the brand guide, sent to the model, and not stored.
- Voice and brand proposals read the artist's own uploads through the artist's own grant, never through the API key or another account's grant. A pending proposal stores its rules and the list of uploads it read (video ID, title, publish date), never descriptions or statistics.
- The database hides a proposal 29 days after its claim, the daily cleanup deletes it, and Disconnect deletes every proposal that read uploads under that grant.
- Approval keeps the rules as the artist's own statement, per the owner's reading of III.E.4.h, with a source summary of counts only; the upload list is dropped.
- Header channel stats are cached in memory only and never written to the database.
- The daily cleanup function runs at 03:00 UTC on the production database branch, deployed on 2026-10-24. It rejects any call that doesn't come from Neon's scheduler and can only delete research that is already past 30 days.

## Planned fanbase learning — spec 006

- Not implemented: pipeline-run research and learning from individual comparable releases and optional artist-authorized YouTube Analytics, guided by saved influence sliders.
- Calculated metrics and subscriber-range targeting stay disabled until YouTube accepts the amendment; retain 30-day statistics expiry and no cross-owner totals.

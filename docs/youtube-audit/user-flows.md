# YouTube audit user flow

Current implementation: sign-in through private upload verification.

```mermaid
%%{init: {"theme": "default"}}%%
sequenceDiagram
  autonumber
  accTitle: Soundboard artist sign-in, review and private upload
  accDescr: The artist signs in and grants Google and YouTube consent, uploads a finished video directly to Cloud Storage, and keeps the page open to drive analysis steps. Soundboard uses Gemma and genre research to draft metadata. The artist reviews and approves a private YouTube upload, which Soundboard verifies through videos.list. Alternative paths cover incomplete consent, a busy model and an unknown upload outcome.

  actor Artist
  participant App as Soundboard
  participant Google as Google OAuth
  participant Storage as Cloud Storage
  participant Model as Gemma on Vertex AI
  participant YouTube as YouTube Data API

  Artist->>App: Sign in with Google
  App-->>Artist: Redirect to Google
  Artist->>Google: Sign in and choose permissions
  Google-->>App: Authorization callback
  App->>Google: Validate identity and exchange code
  Google-->>App: Identity and granted permissions
  Note over App: Check app access before creating a session
  alt YouTube consent incomplete
    App-->>Artist: Signed in; reconnect required before approval
    Artist->>App: Connect or Reconnect on Connections
    App-->>Artist: Redirect to Google consent
    Artist->>Google: Grant missing YouTube permissions
    Google-->>App: Authorization callback
    App->>Google: Exchange code and validate grant
    Google-->>App: Required permissions and usable grant
  else YouTube consent complete
    App-->>Artist: Signed in
  end
  App->>YouTube: channels.list with artist OAuth
  YouTube-->>App: Confirm own channel
  Note over App: Store refresh token encrypted with Cloud KMS

  Artist->>App: Choose video, enter song title, click Analyze
  App-->>Artist: Job and signed upload URL
  Artist->>Storage: Browser uploads video directly
  Storage-->>Artist: Upload complete
  Artist->>App: Page requests prep step
  App->>Storage: Read source through signed URL
  Storage-->>App: Media stream
  App->>App: ffmpeg probes video and measures audio

  loop Page requests steps until all analysis windows finish
    Artist->>App: Page requests next analyze step
    App->>Model: Check readiness
    alt Model busy, loading or scaled to zero
      Model-->>App: Not ready
      App-->>Artist: Show wait reason; page retries later
    else Model ready
      App->>Storage: Read current window
      Storage-->>App: Media stream
      App->>Model: Window audio, frames and measurements
      Model-->>App: Perceptual analysis
      App-->>Artist: Save and show progress
    end
  end

  Artist->>App: Page requests pick step
  App->>YouTube: search.list for genre; videos.list for details
  YouTube-->>App: Genre evidence
  Note over App: Separate per-video candidate lists; timestamp research
  App->>Model: Analysis, genre evidence and artist identity
  Model-->>App: Draft title, description and tags
  App-->>Artist: Editable draft, destination channel, private visibility
  Artist->>App: Review, edit and Approve & upload
  App->>App: Validate fields and grant; pin approved channel
  Artist->>App: Page requests upload step
  App->>Storage: Stream approved source video
  Storage-->>App: Media stream
  App->>YouTube: videos.insert, resumable, private, artist OAuth
  alt Upload outcome unknown
    App-->>Artist: Pause; check YouTube Studio and supply URL or discard
    Note over Artist,YouTube: Validate supplied video's ownership before resuming verification; never blindly re-upload
  else Video ID returned
    YouTube-->>App: Video ID; claimed complete
    Artist->>App: Page requests verification step
    App->>YouTube: videos.list with owner's grant
    YouTube-->>App: Upload status and video details
    App-->>Artist: Verified · private when read-back confirms success
  end
```

- The page drives steps; reload resumes saved progress.
- A Short requires its own review and approval, then uses the same private upload and read-back flow.

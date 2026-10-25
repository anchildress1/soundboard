# YouTube audit user flow

Current implementation: sign-in through private upload verification.

```mermaid
%%{init: {"theme": "default"}}%%
sequenceDiagram
  autonumber
  accTitle: Soundboard artist sign-in, review and private upload
  accDescr: The artist signs in and grants Google and YouTube consent, uploads a finished video directly to Cloud Storage, and keeps the page open to drive analysis steps. Soundboard sends window clips to the Gemini API and uses genre research to draft metadata. The artist reviews and approves a private YouTube upload, which Soundboard verifies through videos.list. Alternative paths cover incomplete consent, a busy model and an unknown upload outcome.

  actor Artist
  participant App as Soundboard
  participant Google as Google OAuth
  participant Storage as Cloud Storage
  participant Model as Gemini API, paid tier
  participant YouTube as YouTube Data API

  Artist->>App: Sign in with Google
  App-->>Artist: Redirect to Google
  Artist->>Google: Sign in and choose permissions
  Google-->>App: Authorization callback
  App->>Google: Validate identity and exchange code
  Google-->>App: Identity and granted permissions
  Note over App: Check app access before creating a session
  alt YouTube consent incomplete
    App-->>Artist: Signed in, reconnect required before approval
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
    App->>Storage: Read current window
    Storage-->>App: Media stream
    App->>App: ffmpeg cuts a small clip with sound and measures the window
    App->>Model: Window clip and measurements
    alt Model busy or daily quota spent
      Model-->>App: 429 or 503
      App-->>Artist: Show model busy or model quota spent, page retries later
    else Model answers
      Model-->>App: Perceptual analysis
      App-->>Artist: Save and show progress
    end
  end

  Artist->>App: Page requests pick step
  App-->>Artist: Researching similar artists
  Note over App,YouTube: Queued batches continue if the page closes, see the research flow below
  App->>YouTube: search.list for genre, videos.list for details
  YouTube-->>App: Genre evidence
  Note over App: Separate per-video candidate lists, timestamp research
  App->>Model: Analysis, genre evidence, peer evidence, results and artist identity
  Model-->>App: Draft title, description, tags and a cited recommendation
  App-->>Artist: Editable draft, destination channel, private visibility
  Artist->>App: Review, edit and Approve & upload
  App->>App: Validate fields and grant, pin approved channel
  Artist->>App: Page requests upload step
  App->>Storage: Stream approved source video
  Storage-->>App: Media stream
  App->>YouTube: videos.insert, resumable, private, artist OAuth
  alt Upload outcome unknown
    App-->>Artist: Pause, check YouTube Studio and supply URL or discard
    Note over Artist,YouTube: Validate supplied video's ownership before resuming verification, never blindly re-upload
  else Video ID returned
    YouTube-->>App: Video ID, claimed complete
    Artist->>App: Page requests verification step
    App->>YouTube: videos.list with owner's grant
    YouTube-->>App: Upload status and video details
    App-->>Artist: Verified · private when read-back confirms success
  end
```

- The page drives steps; reload resumes saved progress.
- A Short requires its own review and approval, then uses the same private upload and read-back flow.

## Research and learning

```mermaid
%%{init: {"theme": "default"}}%%
sequenceDiagram
  autonumber
  accTitle: Peer research and optional analytics learning
  accDescr: The first pick step starts a research run and the queue delivers its batches to the app. If the artist shares analytics, the learn stage reads results for the artist's public uploads. Discover and match find similar artists, and releases picks comparable peer uploads. The pick uses the saved evidence. Disconnecting deletes the analytics results.

  actor Artist
  participant App as Soundboard
  participant Queue as Cloud Tasks
  participant YouTube as YouTube Data API
  participant Analytics as YouTube Analytics API
  participant DB as Neon

  App->>Queue: Pick step starts a run and enqueues the first batch
  loop One batch per delivery until the run is done
    Queue->>App: Delivery with OIDC token
    opt Artist shares analytics, learn stage
      App->>Analytics: Totals for each public upload, artist's own grant
      Analytics-->>App: Reported metrics
      App->>DB: Save results with retrieval time
    end
    App->>YouTube: Genre search, channels and uploads, API key
    YouTube-->>App: Public peer data
    App->>DB: Save peer evidence with retrieval time
  end
  App-->>Artist: Draft, recommendation and peers labeled as reported or calculated
  opt Artist marks Not a peer
    Artist->>App: Reject one peer
    App->>DB: Remember the channel for 29 days
  end
  opt Artist chooses Share analytics
    Artist->>App: Connections, Share analytics
    App-->>Artist: Google consent for yt-analytics.readonly
  end
  opt Artist disconnects YouTube
    Artist->>App: Disconnect
    App->>DB: Delete analytics results
  end
```

- Sharing analytics is optional and separate from sign-in; the draft and approval work without it.
- Peer data and analytics results are hidden after 29 days and deleted daily.
- Peers are individual examples; no totals or combined scores are shown.

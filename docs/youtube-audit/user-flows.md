# YouTube audit user flows

These diagrams describe the current repository implementation.

## Sign-in and YouTube connection

```mermaid
%%{init: {"theme": "default"}}%%
flowchart TD
  accTitle: Soundboard sign-in and connection flow
  accDescr: The artist can read the public privacy policy before signing in. Google sign-in requests identity and YouTube permissions. The server validates identity and app access before creating a session. Incomplete YouTube consent permits sign-in but blocks upload approval. The artist can reconnect or disconnect on the Connections page.

  HOME["Public home page<br/>Privacy policy in footer"] --> LOGIN["Sign in with Google"]
  LOGIN --> GOOGLE["Google identity and YouTube consent"]
  GOOGLE --> ACCESS{"Valid identity and<br/>allowed app access?"}
  ACCESS -->|"No"| DENY["Show sign-in error<br/>No app access"]
  ACCESS -->|"Yes"| SESSION["Create signed session<br/>Show only this user's jobs"]
  SESSION --> GRANT{"Usable grant, required scopes<br/>and own channel confirmed?"}
  GRANT -->|"Yes"| CONNECTED["Connected<br/>Approval available"]
  GRANT -->|"No"| LIMITED["Signed in<br/>Reconnect required before approval"]
  LIMITED --> RECONNECT["Connections: Connect or Reconnect"]
  RECONNECT --> CHECK["Validate callback and same account<br/>Confirm channel and grant"]
  CHECK --> GRANT
  CONNECTED --> DISCONNECT["Connections: Disconnect"]
  DISCONNECT --> PAUSE["Revoke the grant at Google<br/>Remove stored connection<br/>Pause unfinished uploads and verification"]
  PAUSE --> RECONNECT
```

## Analyze, review and upload

```mermaid
%%{init: {"theme": "default"}}%%
flowchart TD
  accTitle: Soundboard video and Short approval flow
  accDescr: The artist supplies a finished video and song title. Browser-driven steps analyze media and retrieve genre evidence before drafting metadata. The artist edits, reruns, discards or approves. Approval validates metadata and pins the destination channel. The app uploads privately and verifies through videos.list. Shorts receive separate review and approval. Unknown upload outcomes require reconciliation instead of an automatic duplicate upload.

  START["Choose finished video<br/>Enter song title; notes optional"] --> GCS["Upload directly to Cloud Storage"]
  GCS --> PREP["Probe video and measure audio with ffmpeg"]
  PREP --> ANALYZE["Analyze one audio and frame window per step"]
  ANALYZE --> READY{"Model available?"}
  READY -->|"No"| WAIT["Show wait reason<br/>Page retries the unfinished step"]
  WAIT --> ANALYZE
  READY -->|"Yes; more windows remain"| ANALYZE
  READY -->|"Yes; windows complete"| RESEARCH["Fetch genre evidence and artist identity<br/>Keep per-video candidate lists separate"]
  RESEARCH --> DRAFT["Draft title, description and candidate-only tags"]
  DRAFT --> REVIEW["Artist reviews and edits<br/>Show destination channel and private visibility"]
  REVIEW -->|"Re-run"| DRAFT
  REVIEW -->|"Discard"| STOP["Stop this job"]
  REVIEW -->|"Approve and upload"| VALIDATE["Check ownership, connection and metadata<br/>Save approved fields and destination channel"]
  VALIDATE --> UPLOAD["videos.insert<br/>Resumable private upload from Cloud Storage"]
  UPLOAD --> OUTCOME{"Upload outcome?"}
  OUTCOME -->|"Video ID returned"| READBACK["videos.list<br/>Read back with the owner's grant"]
  READBACK --> VERIFIED{"Upload verified?"}
  VERIFIED -->|"Not yet"| RETRY["Preserve video ID<br/>Retry verification; do not re-upload"]
  RETRY --> READBACK
  VERIFIED -->|"Yes"| DONE["Verified and private<br/>Open video on YouTube"]
  OUTCOME -->|"Unknown"| RECONCILE["Pause; open YouTube Studio<br/>Artist supplies video URL or discards"]
  RECONCILE -->|"URL belongs to approved channel"| READBACK
  RECONCILE -->|"Discard"| STOP

  REVIEW -->|"Make a Short"| SHORT["Pick hook and render 9:16 clip<br/>Artist reviews clip and its metadata separately"]
  SHORT -->|"Re-cut or re-pick"| SHORT
  SHORT -->|"Approve Short"| VALIDATE
```

- Reloading resumes saved progress; the page must remain open to drive current pipeline steps.
- Lost or revoked YouTube access pauses publishing until the same channel reconnects.
- Upload verification does not make a video public; the artist controls publication in YouTube.
- Bandcamp copy is available to copy and paste; Soundboard does not post it.

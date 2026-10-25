# 🎛️ Soundboard

Soundboard analyzes a finished music video and drafts its YouTube title, description, hashtags, and tags. The artist approves, edits, or re-runs the draft; on approval, Soundboard uploads the video as private and confirms the upload through the YouTube API.

[![Live app](https://img.shields.io/badge/live-soundboard.anchildress1.dev-ff2e88)](https://soundboard.anchildress1.dev)
[![CI](https://github.com/anchildress1/soundboard/actions/workflows/ci.yml/badge.svg)](https://github.com/anchildress1/soundboard/actions/workflows/ci.yml)
[![CodeQL](https://github.com/anchildress1/soundboard/actions/workflows/codeql.yml/badge.svg)](https://github.com/anchildress1/soundboard/actions/workflows/codeql.yml)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=anchildress1_soundboard&metric=coverage)](https://sonarcloud.io/summary/new_code?id=anchildress1_soundboard)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-orange)](LICENSE)

![Node 24](https://img.shields.io/badge/Node-24-5FA04E?logo=nodedotjs&logoColor=white)
![SvelteKit 3](https://img.shields.io/badge/SvelteKit-3-FF3E00?logo=svelte&logoColor=white)
![Gemini API](https://img.shields.io/badge/Gemini%20API-paid%20tier-4285F4?logo=googlegemini&logoColor=white)
![Cloud Run](https://img.shields.io/badge/Cloud%20Run-us--central1-4285F4?logo=googlecloud&logoColor=white)
![Sentry](https://img.shields.io/badge/Sentry-AI%20agent%20tracing-362D59?logo=sentry&logoColor=white)

Built for [Flies Like Robots](https://www.youtube.com/@flieslikerobots) as an entry in the [DEV Hacktoberfest Weekend Challenge: Build for a Friend](https://dev.to/challenges/hacktoberfest-weekend-2026-10-01). Try it at [soundboard.anchildress1.dev](https://soundboard.anchildress1.dev), and read [the submission](https://dev.to/anchildress1/20-years-of-friendship-one-weekend-to-build-his-marketing-department-1bd).

<p align="center">
  <img src="https://repository-images.githubusercontent.com/1403741741/0398d426-9953-4134-8e03-dcbfdb73fd4c" alt="Soundboard" width="100%" />
</p>

---

## Table of Contents

- [About](#about)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Security](#security)
- [How to Contribute](#how-to-contribute)
- [License](#license)
- [Acknowledgements](#acknowledgements)
- [Author](#author)

---

## About

Nathan writes, records, and films his own music. Publishing each video still takes metadata work: a title, a description, tags, hashtags, consistency with the rest of the channel, and a check that the audio isn't clipping or dropping out.

Soundboard produces one complete draft of that metadata for Nathan to review, instead of a set of options to choose from.

The models run on the paid tier of the Gemini API: `gemini-3.8-flash` watches and hears each window of the video, and `gemini-4-argon` writes the draft. Each window leaves our Google Cloud project as a short, low-resolution clip. On the paid tier, Google doesn't use that content to improve its products; what it does keep is on the [privacy page](https://soundboard.anchildress1.dev/privacy).

---

## Features

| Feature                  | Description                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audio and video analysis | Each 60-second window is cut into a small clip with its sound, and Gemini watches and hears it                                                                                                                          |
| Audio measurements       | Loudness, true peak, clipping, and silence are measured with ffmpeg, not estimated by the model                                                                                                                         |
| Upload checks            | "Check before uploading" lists only measured problems: ffmpeg's findings, the Short notice for vertical or square videos of 3 minutes or less, and problems a window analysis heard or saw. The model can't add its own |
| Metadata draft           | One title, description, hashtag set, and tag set, grounded in the most-viewed music videos for its genre                                                                                                                |
| Hashtag candidates       | Hashtags are chosen from a deterministic search of existing videos                                                                                                                                                      |
| Review                   | Edit any field, re-run for a new draft, or approve; edits and approvals inform later drafts                                                                                                                             |
| Verified upload          | Uploads as private, then reads the video back from the YouTube API before marking it verified                                                                                                                           |
| Metadata diff            | For an existing video, shows current and proposed metadata side by side with the reason for each change                                                                                                                 |
| Voice and brand guide    | Proposes a description voice from the artist's own writing and edits, and keep / fix / drop brand rules from 30 latest videos and 10 thumbnails; drafts follow what the artist approves                                 |
| Short                    | Gemini picks the hook, ffmpeg's loudness places the cut, and ffmpeg fits it to 9:16 for review and the same private, verified upload; no generated frames                                                               |
| Tracing                  | One Sentry trace per job, with each Gemini call recorded as an AI agent span                                                                                                                                            |

---

## Tech Stack

| Layer         | Choice                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------- |
| App           | SvelteKit 3 + Svelte 5, TypeScript, Node 24                                                       |
| Model         | Gemini API, paid tier: `gemini-3.8-flash` (analyst), `gemini-4-argon` (picks, guides), via AI SDK |
| Media         | ffmpeg                                                                                            |
| Hosting       | Cloud Run, us-central1                                                                            |
| Data          | Neon Postgres (Drizzle), Cloud Storage, Secret Manager, Cloud KMS                                 |
| YouTube       | YouTube Data API v3                                                                               |
| Observability | Sentry (AI agent tracing)                                                                         |
| Tooling       | pnpm, Vitest, Playwright, ESLint, Prettier, Lefthook, commitlint, Release Please                  |

---

## Architecture

```mermaid
%%{init: {"theme": "default"}}%%
flowchart LR
  accTitle: Soundboard architecture
  accDescr: The browser uploads the video to Cloud Storage, then drives the pipeline one step at a time through the SvelteKit app. The app runs ffmpeg, sends each window's clip to the Gemini API with an API key, stores state in Neon Postgres, reads YouTube with an API key, uploads with OAuth, and sends traces to Sentry.

  B["Browser<br/>status page drives each step"]
  GCS[("Cloud Storage<br/>uploads/")]
  DB[("Neon Postgres<br/>users, jobs, artist memory")]
  YT["YouTube Data API"]
  S["Sentry<br/>one trace per job"]
  GEM["Gemini API · paid tier<br/>analyst + pick models"]

  subgraph GCP["Google Cloud project · us-central1"]
    APP["Cloud Run app<br/>SvelteKit + ffmpeg"]
  end

  B -- "signed PUT" --> GCS
  B -- "POST /api/jobs/:id/step" --> APP
  APP -- "range reads" --> GCS
  APP -- "window clip + text: API key" --> GEM
  APP <--> DB
  APP -- "search + catalog: API key" --> YT
  APP -- "insert + verify: OAuth" --> YT
  B -. "trace" .-> S
  APP -. "gen_ai spans" .-> S
```

- The app runs on Cloud Run with no GPU, at most one instance, and scales to zero when idle. It calls the Gemini API with one API key.
- When Gemini is busy or rate-limited, the step returns at once and the page shows "model busy" and tries again. A spent daily quota shows "model quota spent" until it resets.
- Gemini bills per token and nothing while idle. A 15-minute video costs about $0.25.
- The status page runs the pipeline one step per request (prep, one 60-second window at a time, then the draft; a Short adds a hook pick and a render). Reloading the page resumes from the next unfinished step.
- The full design is in [docs/prd.md](docs/prd.md).

---

## Getting Started

**Prerequisites:** [Volta](https://volta.sh) (pins Node and pnpm per project), ffmpeg, [gitleaks](https://github.com/gitleaks/gitleaks), [actionlint](https://github.com/rhysd/actionlint), and the `gcloud` CLI for deploys.

```bash
git clone git@github.com:anchildress1/soundboard.git
cd soundboard
cp .env.example .env   # fill in the values listed under Configuration
make install
pnpm drizzle-kit migrate
make dev
```

`drizzle-kit migrate` runs over `DATABASE_URL_UNPOOLED`: Neon's pooler can break migrations. Deploys run it too, before the new revision takes traffic.

| Command          | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `make dev`       | Start the dev server                                     |
| `make ai-checks` | Format, lint, typecheck, test, build                     |
| `make e2e`       | Playwright end-to-end tests                              |
| `make deploy`    | Build and deploy the app (requires a clean working tree) |

### Operating it

- **Production database:** provision two secrets from Neon's `main` branch:
  - `DATABASE_URL`: pooled URL for the restricted `soundboard_app` login.
  - `DATABASE_URL_UNPOOLED`: owner's direct URL for migrations and operator commands.

  Replace `YOUR_GCP_PROJECT_ID`; for each command, paste the corresponding URL on standard input and press Ctrl-D:

  ```bash
  gcloud secrets create DATABASE_URL --project=YOUR_GCP_PROJECT_ID --replication-policy=automatic --data-file=-
  gcloud secrets create DATABASE_URL_UNPOOLED --project=YOUR_GCP_PROJECT_ID --replication-policy=automatic --data-file=-
  ```

  `deploy.sh` requires both secrets and grants the owner secret only to the deployer.

  Never derive the owner credential from the app URL or grant the runtime access to the owner secret.

  See [database roles and the deployment freeze](docs/operations/youtube-retention.md#database-roles).

- **Invites:** while `SIGNUP_MODE=invite`, only invited emails can sign in. Manage them with `node --env-file=.env scripts/invite.ts add <email> [--artist flr]`, `revoke <email>`, `reactivate <email>`, or `list`. Locally, the script uses the dev owner's `DATABASE_URL_UNPOOLED` from `.env`; production commands use the owner secret explicitly:

  ```bash
  DATABASE_URL_UNPOOLED="$(gcloud secrets versions access latest --secret=DATABASE_URL_UNPOOLED --project=YOUR_GCP_PROJECT_ID)" node scripts/invite.ts list
  ```

  Replace `YOUR_GCP_PROJECT_ID` and use the same prefix for `add`, `revoke`, or `reactivate`. `--artist flr` links the account to Nathan's existing artist profile. Every other user enters their artist name on first run, with an optional Bandcamp URL and contact line, and can change them later in _Settings_. Revoking signs the user out on their next request.

- **Connections:** signing in also connects the user's own YouTube channel. The _Connections_ page shows its status and offers Reconnect and Disconnect; a missing or revoked grant blocks approval until it's reconnected. Refresh tokens are stored encrypted with the Cloud KMS key.
- **Genre research retention:** database reads exclude research at least 30 days old. Deploy and enable the daily Neon cleanup separately using [the retention procedure](docs/operations/youtube-retention.md); an app deployment alone does not create that schedule.
- **OAuth consent screen:** set it to _In production_ before connecting; Testing-mode refresh tokens expire after 7 days. Add `https://soundboard.anchildress1.dev/auth/callback` and `<run.app service URL>/auth/callback` as redirect URIs: sign-in redirects back to whichever origin the user signed in from.
- **Voice and brand guide:** every user with an artist profile gets a _Brand_ link to `/brand`. _Propose_ reads that artist's latest uploads through the user's own YouTube grant; edit the proposal, then _Approve_. Drafts for that artist follow only its own approved voice and guide; without one they use plain, generic rules. Unapproved proposals expire after 29 days, and Disconnect deletes them.
- **Fanbase learning:** each release first researches similar artists and, if the user opted in on _Connections_, reads their own YouTube Analytics. Research runs through a Cloud Tasks queue that `deploy.sh` creates; see [the runner guide](docs/operations/research-runner.md) for the queue, the one-time setup of a separate environment such as `anchildress1-unstable`, and how to read a stuck run. Peer and analytics data is hidden after 29 days and deleted daily; Disconnect deletes the analytics results.
- **Gemini API key:** create it in a paid-tier project. `make deploy` copies `GEMINI_API_KEY` from `.env` into the `soundboard-gemini-api-key` secret when it changes; dev and prod share the key, its spend, and its daily quota.

---

## Configuration

Values live in `.env` for local development and in Secret Manager or Cloud Run environment variables when deployed. Do not commit real values.

| Variable                                                  | Purpose                                                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GCP_PROJECT_ID`                                          | Project that hosts the service, bucket, and KMS key                                                        |
| `GCS_BUCKET`                                              | Bucket for uploads (`uploads/`, deleted after 7 days)                                                      |
| `GEMINI_API_KEY`                                          | Paid-tier Gemini API key; the only model credential                                                        |
| `GEMINI_ANALYST_MODEL`                                    | Model that watches and hears each window (default `gemini-3.8-flash`)                                      |
| `GEMINI_PICK_MODEL`                                       | Model for the draft, the Short hook, and the voice and brand guides (default `gemini-4-argon`)             |
| `YOUTUBE_API_KEY`                                         | Read-only key from a second GCP project, used for search and catalog reads                                 |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`   | Google sign-in and YouTube upload authorization                                                            |
| `SIGNUP_MODE`                                             | `invite` (default): invited emails only. `open`: any Google account                                        |
| `KMS_KEY`                                                 | Cloud KMS key that encrypts refresh tokens; `deploy.sh` creates it and sets this for the service           |
| `DATABASE_URL`                                            | Neon pooled URL for the restricted `soundboard_app` login; locally, a dev branch (never `main`)            |
| `DATABASE_URL_UNPOOLED`                                   | Neon owner's direct URL for migrations and operator invites; never supplied to the app runtime             |
| `RESEARCH_QUEUE`, `RESEARCH_TASK_URL`, `RESEARCH_TASK_SA` | Cloud Tasks queue, target URL and OIDC account for research; all or none. Set by `deploy.sh`, unset in dev |
| `PEER_HEARING`                                            | `1`: Gemini hears a peer's public upload when matching artists. Unset: metadata only                       |
| `SESSION_SECRET`                                          | Signs the sign-in session cookie                                                                           |
| `PUBLIC_SENTRY_DSN`                                       | Sentry DSN (public by design)                                                                              |
| `SENTRY_AUTH_TOKEN` (in `.env.sentry-build-plugin`)       | Optional. Lets deploys upload source maps; stored in Secret Manager for Cloud Build only                   |

---

## Security

- Video and audio are stored only in Cloud Storage. Each analysis step sends Gemini one short, low-resolution clip, never a link to the upload. Google keeps requests up to 55 days for abuse monitoring and may cache them; the [privacy page](https://soundboard.anchildress1.dev/privacy) has the details.
- Sentry receives prompt and reply text for 30 days, with audio, images, and video replaced by size-only placeholders and values that came from the YouTube API replaced by `[YouTube data]`.
- Every page except home and the sign-in pages, and every API, needs a signed-in Google account (an invited one while `SIGNUP_MODE=invite`). Each user sees and uploads only their own jobs, to their own channel; only accounts linked to Nathan's artist profile read or change his stored preferences.
- Secrets live in Secret Manager or a local `.env`. YouTube refresh tokens stay on the server, encrypted with a Cloud KMS key only the app's service account can use.
- No client access to the database: only the app, migrations, and the invite script connect, using connection strings from Secret Manager or a local `.env`.
- Upload URLs are size-capped, and uploaded files are deleted after 7 days.

---

## How to Contribute

Issues and pull requests are welcome.

- Branch from `main` and open a pull request; `main` is not committed to directly.
- Use [Conventional Commits](https://www.conventionalcommits.org), GPG-signed, with an AI attribution footer and `Signed-off-by`. commitlint and [rai-lint](https://github.com/anchildress1/rai-lint) enforce this.
- Run `make ai-checks` before pushing.

---

## License

This repository's code is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). It is not open source. You may read, run, modify, and share it for any noncommercial purpose, such as personal study, hobby projects, or research with no commercial application. Charities, schools, public research, safety, health, and environmental organizations, and government bodies may use it however they are funded. Other commercial use, including running it to grow a monetized channel, selling it, or offering it as a hosted service, needs separate written permission.

Artists can email [anchildress1@gmail.com](mailto:anchildress1@gmail.com) to ask for permission to run their own copy, or for an invite to test the hosted version.

Releases up to and including v1.0.0 were published under MIT and stay MIT. The PolyForm terms apply to everything after that release.

---

## Acknowledgements

- **Nathan (Flies Like Robots)**, for the music and for being the first user.
- **DEV** and **MLH**, for running the Hacktoberfest Weekend Challenge that prompted this build.

---

## Author

**Ashley Childress** — [@anchildress1](https://github.com/anchildress1) · [dev.to/anchildress1](https://dev.to/anchildress1)

# Implementation Plan: Google Sign-In and Connections

**Branch**: `feat/sign-in-page` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-google-sign-in/spec.md`

## Summary

Make the app invite-only behind Google sign-in. One consent screen grants identity plus YouTube.

- **Users:** keyed by the Google `sub` (the account's permanent ID). Sessions stay signed `{uid, sid, gen, exp}` cookies with a fixed 30 days, so concurrency needs no session store.
- **Tokens:** each user's YouTube refresh token is KMS-encrypted on their Firestore connection doc.
- **Jobs:** each job gets an `ownerUid`, plus a destination channel that's pinned at approval.
- **Removed:** visitors, demo accounts, samples, the sandbox channel and the dev.to framing.
- **Nathan's data:** moved by an idempotent script that proves his `sub` and channel from his existing grant.

## Technical Context

**Language/Version**: TypeScript 6 strict, Node 24.21 (`.nvmrc`)

**Primary Dependencies**:

- Existing:
  - SvelteKit 2.70 / Svelte 5 runes, adapter-node 5
  - `google-auth-library` 11.1.0 (OAuth, ID-token verify)
  - `@google-cloud/firestore` 9.2.0
  - `@google-cloud/secret-manager` 7.1.0, kept for app secrets only
  - `@sentry/sveltekit` 11.4.0
- New: `@google-cloud/kms` 6.2.1 (research R7)

**Storage**:

- Firestore: new `users`, `users/*/connections`, `invites`; changed `jobs`, `quota`.
- One new KMS key ring and key, `soundboard / refresh-tokens`, in us-central1.

**Testing**: Vitest 5 with `@vitest/coverage-v8` (85/85/85/80 floors), Playwright 1.63 (desktop Chrome, Pixel 7), and E2E fakes aliased by `E2E_FAKES=1`. A new fake KMS goes in `tests/e2e/fakes/kms.ts`.

**Target Platform**: Cloud Run (one service, max 1 instance) in us-central1

**Project Type**: Web application, SvelteKit single project

**Performance Goals**:

- One Firestore read per authenticated request, `users/{uid}`. The invite is read only at sign-in.
- Callback processing under 1 s, plus Google's own calls (SC-003).

**Constraints**:

- No new services, queues or workers (AGENTS.md).
- Steps stay under about 2 minutes.
- No whole-media buffering.
- Token bytes never reach Sentry or logs.

**Scale/Scope**: 2 invited users now; open signup later, capped at 100 until Google verifies the app (research R9). 6 uploads a day, shared (research R8).

## Constitution Check

Gates from `.specify/memory/constitution.md` v1.0.0.

| Principle                     | Status                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| I. Owned Data                 | ✅ `ownerUid` 404s, per-channel caches, KMS tokens. Unlinked users get no artist name, tags, facts or memory                              |
| II. Truthful Output           | ✅ `VERIFIED` still by read-back through the pinned grant. Artist tag only from the linked profile                                        |
| III. One Service, Page-Driven | ✅ KMS is a managed API call. Lost grant and unknown outcome are wait reasons                                                             |
| IV. Domain-Grouped Code       | ✅ New files land in domain folders; YouTube code stays in `platforms/youtube/`. ⚠️ `ARTIST_VOICE` stays shared until spec 002 (`TTD.md`) |
| V. Tested at the Boundaries   | ✅ KMS, Firestore and Google HTTP mocked as boundaries. ⛔ Brand Account gate still open                                                  |
| VI. Simplicity                | ✅ No session store, no per-request invite read, no platform interface yet                                                                |
| Media, Privacy and Secrets    | ✅ Tokens, ciphertext and ID tokens never set on spans                                                                                    |

**Post-design re-check:** BLOCKED until the manual gate in [quickstart](quickstart.md#manual-brand-account-gate-t001-before-the-callback-work) passes. The KMS dependency also needs your OK, because `package.json` is a repo config file.

## Project Structure

### Documentation (this feature)

```text
specs/001-google-sign-in/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/http.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── hooks.server.ts                    # gate (R11), session → locals.user, CSP 'self'
├── app.d.ts                           # locals.user: {uid, email, artistId} | null
├── lib/driver.ts                      # 401 is final → navigate to /
├── lib/server/                        # layout from refactor/server-domains
│   ├── core/env.ts                    # drop allowlist/demoEmails; add SIGNUP_MODE, KMS_KEY
│   ├── core/kms.ts         (new)      # encrypt/decrypt
│   ├── auth/auth.ts                   # session {uid,sid,gen,exp}, OAuth state {purpose,uid,sid}, prompts
│   ├── auth/users.ts       (new)      # getUser, redeemInvite (transaction), upsertUser (never writes gen)
│   ├── jobs/jobs.ts                   # ownerUid, parentId, destination, upload markers; listJobs(uid); releaseJob keeps videoId
│   ├── jobs/create.ts                 # drop samples, visitor runs, ownerFor
│   ├── jobs/actions.ts                # approve pins destination + uploadSlotDay; discard in PUBLISHING/CLAIMED_COMPLETE
│   ├── jobs/quota.ts                  # uploads only; releaseUploadSlot(day)
│   ├── jobs/view.ts                   # authorizedJob(id, uid)
│   ├── jobs/samples.ts     (removed)
│   ├── artist/memory.ts               # read/write gate by artistId; PUBLIC_FACTS only when linked
│   ├── artist/brand.ts                # recentVideos(FLR_CHANNEL_ID) passed explicitly
│   ├── ai/smart-pick.ts               # artistId in context; null → no artist tag, name or facts
│   ├── pipeline/pipeline.ts           # connection-gated upload steps, outcome-unknown wait
│   ├── platforms/youtube/connection.ts (new)  # evaluate grant (FR-027), get/put/delete, accessTokenFor(uid, channelId)
│   ├── platforms/youtube/youtube.ts   # channelStats(channelId) per-channel cache; videoChannel(id) for pasted URLs
│   └── platforms/youtube/tokens.ts (removed)  # replaced by connection.ts
├── lib/components/Diff.svelte (removed), SignIn.svelte (new), JobList.svelte (new)
└── routes/
    ├── +page.svelte / +page.server.ts # sign-in view | upload form + job list
    ├── +layout.svelte                 # header: user's channel, Connections, Brand guide (artist only)
    ├── connections/+page.{svelte,server.ts}           (new)
    ├── api/connections/youtube/disconnect/+server.ts   (new)
    ├── api/jobs/[id]/confirm-upload/+server.ts         (new)
    ├── jobs/[id]/+page.svelte         # outcome-unknown: Studio link, paste-URL field, Discard
    ├── auth/{login,callback,logout}/+server.ts
    └── brand/…                        # gate by user.artistId; connect links removed
scripts/
├── invite.ts               (new)  # add | revoke | list; standalone Firestore client
├── migrate-v2.ts           (new)  # R10; --expect-email, --dry-run; idempotent
└── add-sample.sh           (removed)
tests/
├── unit/…                          # mirrors src/
├── e2e/fakes/{kms.ts (new), firestore.ts (where/orderBy), fixtures.ts (users, invites, connections)}
└── e2e/{auth,isolation,connections}.spec.ts
deploy.sh, service.yaml, .env.example, README.md, AGENTS.md
```

**Structure Decision**: Single SvelteKit project, so existing directories are reused. The two scripts run directly under Node 24's built-in type stripping. They import only `@google-cloud/*` and `google-auth-library`, never `$lib`, because `$lib` aliases need Vite.

## Key Decisions

- **Gate placement:** one handle in `hooks.server.ts` covers pages and `+server.ts`. There's no wildcard API exemption (FR-002).
- **Revocation without a session store:** each user has an `accessGeneration` counter, compared on every request (FR-006). That's the only per-request read.
- **Browser sessions:** a random `sid` per sign-in, bound into the OAuth state, so stale connect callbacks fail after sign-out and back in (FR-026).
- **Refresh tokens:** KMS-encrypted in Firestore, so the connection and its token are one atomic write (R7). Cleared on `revoked`.
- **Returning sign-in:** skips consent and keeps the stored grant if it's `connected` and `mine=true` matches (R4). With no usable stored grant and no new refresh token, sign-in goes straight to the consent flow.
- **Destination pinning:**
  - `job.destination` and `job.uploadSlotDay` are set at approval.
  - Persist `uploadStartedAt` before the first upload-initiation request; session resets and retries never clear it.
  - A mismatch while that marker is null sends the job back to `REVIEW` and releases its slot on `uploadSlotDay`.
  - A mismatch after that is a wait, even if `job.upload` has been cleared.
  - Every upload step checks the pinned channel's connection is `connected` first; session PUTs carry no auth header (R6).
  - Persist top-level `job.finalChunkAt` before sending the chunk that reaches the file size.
  - Session 404 with `finalChunkAt` null → fresh session, same destination. With it set → wait "upload outcome unknown" with a YouTube Studio link (R6). The owner pastes the video URL through `POST /api/jobs/{id}/confirm-upload`; verify its channel, record the ID and continue normal read-back. Or Discard. The app never searches or re-uploads on its own.
  - A fresh session keeps its slot on the same quota day and takes today's slot on a later one.
  - A step result landing after a discard still saves `videoId` (FR-025).
  - A wait never fails the job (FR-022 to FR-024).
- **Header stats:** `channelStats(channelId)` through the API key, cached per channel ID. This fixes today's cache, which serves Nathan's channel to everyone (FR-030).
- **Pick identity until spec 002:** picks use FLR data only when the job's and the owner's current `artistId` both equal `flr`. That covers `artists/flr` memory, `recentVideos(FLR_CHANNEL_ID)`, `PUBLIC_FACTS`, the `artist` field, and the forced `ARTIST_NAME` tag in the pick and in the approve-time tag check (`smart-pick.ts:143-174`, `actions.ts:46`, `memory.ts:31`). Otherwise none of them apply; feedback stays on the job. `ARTIST_VOICE` stays shared until spec 002.
- **Signup setting:** `SIGNUP_MODE=invite|open` env var (FR-007).
- **Nathan's migration:** his legacy grant's ID token must match `--expect-email`, before traffic moves (R10). Rehearsed on an emulator import of the export first.

## Risks

- **Brand Account `sub` behavior is UNCONFIRMED.** The T001 manual gate blocks the callback work.
- **Resuming a session after reconnect is UNCONFIRMED.** Check its status first; a 404 restarts only if the final bytes were never sent, otherwise it waits for the owner (R6).
- **The 6-a-day figure may be stale.** Google's page now lists a separate uploads bucket (R8); read the real number in the Console.

## Config changes needing your OK

- `package.json` / `pnpm-lock.yaml`: add `@google-cloud/kms@6.2.1`.
- `deploy.sh`:
  - create the KMS key ring and key
  - grant the runtime service account `roles/cloudkms.cryptoKeyEncrypterDecrypter` on that key
  - drop the `yt-refresh-*` secret creation after cutover
  - drop `ALLOWLIST_EMAILS` / `DEMO_EMAILS`
  - add `SIGNUP_MODE` and `KMS_KEY`
  - add the Firestore index
- `service.yaml`, `.env.example`, `playwright.config.ts`: the same env changes.
- `vite.config.ts`: alias `@google-cloud/kms` to the E2E fake.

## Complexity Tracking

None. No gate violations.

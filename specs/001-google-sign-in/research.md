# Research: Google Sign-In and Connections

Checked 2026-10-16 against Google's docs. **UNCONFIRMED** marks anything Google doesn't document; those items are checked in the deployed manual run.

## R1 · User identity key

- **Decision:** key users on the ID token's `sub`. Key the YouTube channel on `channels.list?mine=true` → `id`, stored separately on the connection.
- **Rationale:** Google says `sub` is unique across all Google Accounts and never reused, and that apps should key on it rather than on email ([OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)).
- **Alternatives:** keying on email was rejected because it changes and can be reassigned. Keying on the channel ID was rejected because it isn't an identity, and a user can switch channels.

## R2 · Brand Account channels

- **Decision:** out of scope. No current user has a Brand Account channel, so each grant's `mine=true` is the signed-in account's own channel.
- **Why it matters later:** community reports say picking a Brand Account during consent ties the token to that account ([gist](https://gist.github.com/veuncent/e0b831ab41d598961d2656c7fc5cc0f9)), which could change `sub`. Supporting Brand Accounts needs its own spec and a real-account test first.

## R3 · Scopes and partial grants

- **Decision:** request `openid email https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly` with `access_type=offline` and `include_granted_scopes=true`. Split the token response's `scope` on spaces. YouTube counts as connected only when both YouTube scopes are present.
- **Rationale:** users can untick scopes, and apps must disable the affected features rather than fail ([web server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions)).
- **Alternatives:** treating a partial grant as a failed sign-in was rejected; FR-027 says identity still signs in.

## R4 · Refresh tokens

- **Facts:**
  - Google returns a refresh token only on the first authorization, unless `prompt=consent` forces a new one ([web server flow](https://developers.google.com/identity/protocols/oauth2/web-server)).
  - There's a limit of 100 per Google Account per client, and past it the oldest is silently invalidated.
  - A token stops working after 6 months unused, after revocation, or after 7 days in Testing mode ([expiration](https://developers.google.com/identity/protocols/oauth2#expiration)).
- **Decision:**
  - Sign-in uses `prompt=select_account`, so returning users skip consent and keep their stored grant.
  - Connect and Reconnect use `prompt=select_account consent` to force a fresh refresh token.
  - A sign-in without a new refresh token keeps the stored grant only if the stored doc is `connected` and `mine=true` with the new access token returns the stored channel ID.
- **Alternatives:** forcing consent on every sign-in was rejected. It's annoying, and each new token counts toward the 100 limit.

## R5 · Disconnect

- **Decision:** Disconnect POSTs the refresh token to `https://oauth2.googleapis.com/revoke`, then deletes the connection.
- **Rationale:** an unrevoked grant stays live and counts toward the token limit ([revoke](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke)).
- **Catch:** this revokes the combined grant, sign-in scopes included. The app session is the app's own cookie, so the user stays signed in. The next sign-in shows consent again.

## R6 · Resumable upload after reconnect

- **Facts:**
  - Session URIs expire without a documented lifetime and return 404 when they do ([resumable protocol](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)).
  - The app's session PUTs send no `Authorization` header (`youtube.ts:248-286`); the session URI is the credential. So a 401 isn't a real path, and revoking at Google doesn't stop a live session.
- **UNCONFIRMED:** whether a session survives revoke plus re-consent on the same channel.
- **Decision:**
  - Gate every upload step on the pinned channel's connection doc being `connected`; otherwise wait "reconnect YouTube".
  - After reconnect, check the stored session. Complete → keep the video ID and verify. Incomplete → resume from its offset, no second slot.
  - A 404 proves nothing if the final bytes were sent, since the upload may have finished before its response was lost. So persist top-level `job.finalChunkAt` before that chunk. It must not live in `job.upload`, which Retry and session loss reset.
  - 404 with `finalChunkAt` null → known incomplete; a fresh session on the pinned channel is safe.
  - 404 with it set → wait "upload outcome unknown" with a link to the channel's uploads in YouTube Studio. The owner pastes the video URL or discards. A pasted ID is accepted only if `videos.list?id=…` through the pinned grant returns it with the pinned `channelId` (1 unit, [quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)).
  - **Alternatives:** searching the uploads playlist for title/time matches was rejected. A match isn't proof it's this job's upload, the search costs quota on every wait poll, and it's unconfirmed whether private uploads show up there promptly. Auto-restarting after a timeout was rejected because a late-listed upload becomes a duplicate.
  - Session expiry or replacement never clears the destination lock (FR-023, FR-028).

## R7 · Where refresh tokens live

- **Decision:** encrypt each user's refresh token with one Cloud KMS key and store the ciphertext on the Firestore connection doc. Add `@google-cloud/kms` pinned to **6.2.1** (released 2026-09-28; 6.3.0 is only 4 days old).
- **Rationale:**
  - Google positions Secret Manager for stored secrets and KMS for "encrypting rows in a database" ([Secret Manager overview](https://docs.cloud.google.com/secret-manager/docs/overview), [encrypting application data](https://docs.cloud.google.com/kms/docs/encrypting-application-data)).
  - A token is about 100 bytes, under KMS's 64 KB direct-encrypt limit, so no envelope encryption is needed.
  - The token and its channel record land in one Firestore write, which makes "validate, then replace" atomic (FR-027).
  - The runtime account needs `cloudkms.cryptoKeyEncrypterDecrypter` on one key, not secret-create rights across the project.
- **Alternatives:**
  - One Secret Manager secret per user was rejected. It needs project-wide create and delete rights, costs per user per month ([pricing](https://cloud.google.com/secret-manager/pricing)), and can't be written atomically with the connection doc.
  - Plaintext in Firestore was rejected outright.

## R8 · Upload quota

- **Facts:**
  - The `videos.insert` page now lists a separate "Video Uploads" bucket of 100 calls a day.
  - It also says unverified projects are no longer limited to private uploads ([videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)).
  - The 1,600-unit cost behind today's 6-a-day figure may be stale.
- **Decision:** keep `UPLOADS_PER_DAY = 6` as one shared pool (FR-017) until the project's real quota is read in the Cloud Console. Changing the number is a one-line follow-up. Uploads stay private by product rule.

## R9 · Unverified app cap

- **Facts:** unverified apps using sensitive or restricted scopes get 100 new users in total, over the project's lifetime, and it can't be reset ([unverified apps](https://support.google.com/cloud/answer/7454865), [user cap](https://support.google.com/cloud/answer/13463817)).
- **UNCONFIRMED:** whether `youtube.upload` is classed as sensitive. Only third parties say so; the Console's Data Access page will show it.
- **Decision:** no action for the invite phase. Open signup needs Google's verification first.

## R11 · Static assets and the auth gate

- **Decision:** the gate lives in `hooks.server.ts`.
  - Allowed without a session: `/auth/login`, `/auth/callback`, `/auth/logout`, `/health` and `/`, where `/` renders the sign-in view.
  - Every other page redirects with 303 to `/`. Every `/api/*` returns 401.
  - Static and `_app/immutable` files are served by adapter-node before the SvelteKit handler and contain no app data.
- **Alternatives:** a guard in `+layout.server.ts` was rejected because it doesn't cover `+server.ts` APIs.

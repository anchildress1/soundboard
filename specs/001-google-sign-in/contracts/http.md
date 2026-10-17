# HTTP Contract: Google Sign-In and Connections

The auth gate lives in `hooks.server.ts` (research R11). "Session" means a valid `sb_session` per [data-model](../data-model.md#session-cookie-sb_session).

## Gate

| Request without a session          | Response                                      |
| ---------------------------------- | --------------------------------------------- |
| `GET /`                            | 200, sign-in view only, no `Set-Cookie`       |
| `GET /auth/login`                  | 303 to Google, sets `sb_oauth`                |
| `GET /auth/callback`               | Validates its own flow (below)                |
| `POST /auth/logout`, `GET /health` | Unchanged                                     |
| Any other page                     | 303 → `/`                                     |
| Any `/api/*`                       | 401 `{"message":"Sign in first."}`, no writes |

- Every response sends `content-security-policy: frame-ancestors 'self'` (FR-019).

## `GET /auth/login`

| Query              | Needs              | Google params                                                                               |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------- |
| none               | —                  | all 4 scopes, `access_type=offline`, `include_granted_scopes=true`, `prompt=select_account` |
| `?connect=youtube` | session (else 401) | same scopes, `prompt=select_account consent`, `login_hint=<user email>`                     |

- Any other `connect` value returns 400. The `nathan` and `sandbox` values are removed (FR-020).

## `GET /auth/callback`

| Case                                                      | Result                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| Missing, expired or mismatched `state`, or no `code`      | 303 `/?signin=expired`; nothing stored                                      |
| ID token unverified or email unverified                   | 303 `/?signin=expired`                                                      |
| Sign-in, not invited (or invite bound to another `sub`)   | 303 `/?signin=denied`; no cookie, no user, no token (FR-005)                |
| Sign-in, invited                                          | Upsert user, bind invite, set `sb_session`, then evaluate YouTube → 303 `/` |
| Connect, `uid` or `sid` differs from state, or no session | 303 `/connections?connect=mismatch`; no change (FR-026)                     |
| Connect, ID token `sub` ≠ session `uid`                   | 303 `/connections?connect=wrong-account`; no change (FR-023)                |
| Connect, valid                                            | Evaluate YouTube → 303 `/connections`                                       |

**Evaluating YouTube (FR-027):**

1. Either required YouTube scope is missing from `tokens.scope` → `missing_scopes`. An existing `connected` row stays untouched. Read-only, upload-only and neither-scope grants all fail this check.
2. `channels.list?mine=true` returns nothing → `no_channel`, same rule.
3. A refresh token came back → encrypt it and write `connected` with the channel, in one write.
4. No refresh token came back, the stored row is `connected`, and its channel ID matches → keep the stored grant.
5. No refresh token came back and there's no usable stored grant → on sign-in, 303 straight to `/auth/login?connect=youtube`, which forces consent. This covers anyone who granted this client before v2, such as Ashley.
6. Otherwise → `missing_scopes`, with "Reconnect to finish". A sign-in never erases a stored grant.

## `/connections` (page)

- One YouTube row showing the status, channel title, and Reconnect or Disconnect.
- Statuses `missing_scopes`, `no_channel` and `revoked` show a plain fix line.

## `POST /api/connections/youtube/disconnect`

- Requires a session. Revokes the refresh token at Google (a failure there is logged and the delete goes ahead), then deletes the row → 204.

## Job APIs (changed behavior)

| Route                                      | Change                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/jobs`                           | `{sampleId}` is removed. Owner is `session.uid`. 15-minute cap for everyone                                                                             |
| `GET/POST /api/jobs/{id}/**`, `/jobs/{id}` | 404 unless `job.ownerUid === session.uid` (FR-012)                                                                                                      |
| `POST /api/jobs/{id}/approve`              | 409 `"Reconnect YouTube to approve."` unless connected. 409 `"Daily upload limit reached. Try tomorrow."` when the pool is spent. Records `destination` |
| `POST /api/jobs/{id}/step`                 | In `PUBLISHING` / `CLAIMED_COMPLETE`, returns wait `"reconnect YouTube"` on a missing or revoked grant for the pinned channel                           |
| `POST /api/jobs/{id}/discard`              | Also allowed in `PUBLISHING` and `CLAIMED_COMPLETE` (FR-025)                                                                                            |
| `GET /` (signed in)                        | Data adds `jobs: {id, songTitle, state, createdAt}[]`, newest 20 root jobs (FR-029)                                                                     |

- Upload start is the durable `uploadStartedAt` marker, not the presence of `job.upload`. Session expiry and retries never unlock the destination.
- Each upload step checks the pinned channel's connection is `connected` before touching the session, because session PUTs carry no auth header.
- `POST /auth/logout` also deletes `sb_oauth`.
- Client driver (`src/lib/driver.ts`): a 401 from any step is final and navigates to `/`. Today it only stops on 403/404 and retries a 401 forever.
- A session 404 before the final chunk was sent restarts on the pinned destination. After it may have been sent, the step returns wait `"upload outcome unknown"` with a YouTube Studio link for the pinned channel, and makes no YouTube call. It never re-uploads on its own.

## `POST /api/jobs/{id}/confirm-upload`

- Requires the job owner's session, a job in the outcome-unknown wait (`PUBLISHING`, `finalChunkAt` set, `upload` and `videoId` null, per [data-model](../data-model.md#publishing-and-verification-with-a-pinned-destination)), and `{url}` pasted by the owner. Accepts `watch?v=`, `youtu.be/`, `/shorts/` and Studio `/video/` URLs; anything else returns 400. A foreign job returns 404; a stale or ineligible job returns 409.
- Read the selected video through the owner's pinned-channel grant and return 422 `"That video isn't on <channel title>."` for a missing video or a channel mismatch, with no job change. Atomically re-check the job and destination, save the confirmed ID and move to `CLAIMED_COMPLETE`; normal read-back alone sets `VERIFIED`. This action never initiates an upload or takes an upload slot.

## Removed

- The `?connected=` toast and the Brand guide connect links.
- The sample list, `Diff` and `liveVideoId` in the job view.
- The demo banner.

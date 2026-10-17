# Quickstart: Validating Google Sign-In and Connections

## Automated

```bash
make ai-checks          # format, lint, typecheck, unit tests (coverage floors), build
pnpm test:e2e           # desktop Chrome + Pixel 7, E2E_FAKES=1
```

Expected:

- **Unit tests** cover the gate for every route file (SC-001), session shape, generation and expiry, every callback row in [contracts/http.md](contracts/http.md), invite binding, one-process isolation (SC-005), the pinned-destination transitions in [data-model.md](data-model.md#publishing-and-verification-with-a-pinned-destination), and migration idempotence (SC-009).
- Include read-only, upload-only and neither-scope consent; expired/cleared upload sessions with a channel switch; a lost final upload response followed by completed, incomplete and unknown status, staying paused with no automatic upload; a pasted URL accepted on the pinned channel and rejected when missing, malformed or on another channel; Retry after a lost final chunk never restarting; a discard during the final chunk keeping the video ID; a slot released on a later day decrementing its own day; a stale connect callback after sign-out and back in; a revoked connection not revived by sign-in; a returning grantor with no refresh token sent to consent; and an unlinked user's pick with no artist memory, name, tag or facts.
- **E2E tests** seed two users through the fakes and cover:
  - signed-out `/` sets zero cookies, other pages redirect, `/api/*` returns 401
  - each user sees only their own job list and jobs
  - Connections renders every status
  - Discard works on a paused job
  - a 401 mid-run sends the page to sign-in

## Manual: Brand Account gate (T001, before the callback work)

1. Use a test Google account that has a personal channel and a Brand Account channel.
2. Sign in through a throwaway OAuth client with the four scopes, picking the personal channel. Record `sub`, `email` and `mine=true` → channel ID.
3. Repeat, picking the Brand Account channel.
4. **Pass:** `sub` is the same both times and `mine=true` returns the channel picked. **Fail:** stop and take the decision back to the user (research R2).
5. Refresh the stored token offline and confirm it still returns the same channel.
6. Reconnect the same channel with `prompt=consent` and confirm a usable new token for the same channel. Then reconnect picking the other channel and confirm `mine=true` follows the pick.
7. Record results in `specs/001-google-sign-in/research.md` under R2. No tokens.

## Manual: deployed

1. Seed invites: `node scripts/invite.ts add <email> [--artist flr]`.
2. Sign in as an invited user and approve one consent screen. Home shows your channel and your job list (SC-003).
3. Sign in from an uninvited account and get "not invited", with no cookie (SC-001).
4. Revoke access at myaccount.google.com/permissions. Connections shows reconnect, approval is blocked, and Reconnect restores it (SC-006).
5. Run `node scripts/invite.ts revoke <email>`. The next request from that user is signed out.

## Cutover

1. Take a Firestore export.
2. Rehearse: import the export into the Firestore emulator and run `node scripts/migrate-v2.ts --expect-email <email>` against it twice. The second run reports 0 changes.
3. Deploy the new revision with `--no-traffic`.
4. Run `node scripts/migrate-v2.ts --expect-email <email> --dry-run`, then run it for real.
5. It reports Nathan's `sub`, the email and channel match, and job and Short counts before and after. A second run reports 0 changes.
6. Move traffic. Sign in as Nathan's account and confirm his jobs are listed.

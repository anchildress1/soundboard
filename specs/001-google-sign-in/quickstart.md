# Quickstart: Validating Google Sign-In and Connections

## Automated

```bash
make ai-checks          # format, lint, typecheck, unit tests (coverage floors), build
pnpm test:e2e           # desktop Chrome + Pixel 7, E2E_FAKES=1
```

Expected:

- **Unit tests** cover the gate for every route file (SC-001), session shape, generation and expiry, every callback row in [contracts/http.md](contracts/http.md), invite binding, one-process isolation (SC-005), the pinned-destination transitions in [data-model.md](data-model.md#publishing-and-verification-with-a-pinned-destination).
- Claim ownership: let A's claim expire, acquire B's fresh token, then complete A late. Assert no result or child-table writes from A and B's claim unchanged; B then completes successfully. A late upload result after discard may save the video ID only with its still-matching token and must preserve the discarded state.
- Include read-only, upload-only and neither-scope consent; expired/cleared upload sessions keeping the upload-start mark; a reconnect from another Google account rejected; a lost final upload response followed by completed, incomplete and unknown status, staying paused with no automatic upload; a pasted URL accepted on the pinned channel and rejected when missing, malformed or on another channel; Retry after a lost final chunk never restarting; a discard during the final chunk keeping the video ID; YouTube's quota-spent and per-channel upload-limit responses pausing the job without failing it; a stale connect callback after sign-out and back in; a revoked connection not revived by sign-in; a returning grantor with no refresh token sent to consent; and an unlinked user's pick with no artist memory, name, tag or facts.
- **E2E tests** seed two users through the fakes and cover:
  - signed-out `/` sets zero cookies, other pages redirect, `/api/*` returns 401
  - each user sees only their own job list and jobs
  - Connections renders every status
  - Discard works on a paused job
  - a 401 mid-run sends the page to sign-in

## Manual: deployed

1. Seed invites: `node scripts/invite.ts add <email> [--artist flr]`.
2. Sign in as an invited user and approve one consent screen. Home shows your channel and your job list (SC-003).
3. Sign in from an uninvited account and get "not invited", with no cookie (SC-001).
4. Revoke access at myaccount.google.com/permissions. Connections shows reconnect, approval is blocked, and Reconnect restores it (SC-006).
5. Run `node scripts/invite.ts revoke <email>`. The next request from that user is signed out.

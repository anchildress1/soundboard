# Contract: artist voice and brand guide

Interfaces this feature adds or changes. Shapes are in [data-model.md](../data-model.md), and the reasoning is in [research.md](../research.md).

## Common to every `/api/guides/{kind}/*` route

- `kind` is `voice` or `brand` (the `guide` matcher in `src/params.ts`). Anything else is a 404.
- Signed out → `401 "Sign in first."`. No profile → `404 "Not found"` (`requireArtist`). Never 403.
- Every read and write is keyed by `locals.user.artist.id`. A body naming another artist is ignored; there is no artist field.
- The old `/api/brand/{propose,approve,discard}` routes are deleted.

## `POST /api/guides/{kind}/propose`

One page-driven step. It claims the (artist, kind) slot first. The step deadline starts at entry and is shared by the claim, the YouTube reads, thumbnails and the model call (research R8).

- **200 `{ proposal: Proposal }`**: the new pending proposal, replacing any earlier one (new `id`).
- **200 `{ wait: 'model busy' }`**: the provider answered 429/503, or too little step time was left for the model call (`hasModelTime`). The page asks again with `POLL_BACKOFF`. Nothing stored.
- **200 `{ wait: 'model quota spent', limitUntil: number }`**: the per-day model quota is spent; `limitUntil` is the reset (epoch ms). The page stops and shows the wait. Every propose for this artist and kind returns the same body until then, with no YouTube or Gemini call. Nothing stored.
- **200 `{ wait: 'waiting on YouTube' }`**: `identityFailure` classified the read error as `busy`: 403 `quotaExceeded`, `dailyLimitExceeded`, `rateLimitExceeded` or `userRateLimitExceeded`; 429; 5xx; network; abort; `DeadlineSpent`. The grant is untouched. The page asks again. Nothing stored.
- **200 `{ wait: 'reconnect YouTube' }`**, nothing stored, approved rules untouched (spec edge case). The page stops and links to Connections. Any of:
  - the connection is revoked or missing scopes, or `accessTokenFor` returns null
  - `identityFailure` says `access-lost` (401; 403 `forbidden`, `insufficientPermissions` or another unlisted reason; 404); the grant is marked refused
  - YouTube was disconnected before the save
  - brand only: never connected or no channel (constitution III: a missing grant is a wait)
- **409**, nothing stored, no model call:
  - voice, no usable uploads and no EDITED rows: `"Nothing to learn from yet. Connect YouTube or finish a few releases first."` (US1 AS4)
  - brand, zero uploads: `"The channel has no public uploads to learn from."`
  - another propose for this artist and kind holds the claim: `"A proposal is already running in another tab."`
- **502** `"The model reply did not parse as a voice."` / `"… as a brand guide."` after the one re-ask. Nothing stored.
- **500** on `app-rejected` (004's mapping) or any other error. Nothing stored. The claim is released.
- **Reads:**
  - voice: the owner's 30 newest uploads (`snippet` only), split into "Written by the artist" and "Approved Soundboard drafts (lower weight)", plus the owner's newest 60 feedback rows. No thumbnails.
  - brand: the owner's 30 newest uploads and 10 thumbnails.
  - Never `statistics`, never comments (FR-003).
- **Sentry:** upload text shows as `[YouTube uploads: <n>]`; the reply and reasoning of `voice-guide` and `brand-guide`, including a re-ask's resent reply, show as `[guide proposal: <n> chars]`.

## `POST /api/guides/{kind}/approve`

- **Body:** voice `{ proposalId: number, rules: string[] }`; brand `{ proposalId: number, statement: string, keep: string[], fix: string[], drop: string[] }`.
- **400** `"Name the proposal being approved."` without a numeric `proposalId`; `"Expected voice rules."` / `"Expected a statement and keep, fix, drop lists."` on the wrong shape.
- **422** with the first `voiceError` / `guideError` message. Nothing written.
- **404** `"The guide changed in another tab. Reload to see it."` when the pending proposal is gone, expired, has a different `id`, or belongs to another artist (invisible under RLS). One answer for all four; no cross-tenant lookup (research R9, R11). Nothing written.
- **200 `{ approved: Approved }`**: the edited text becomes the active version; the proposal is deleted. Sources collapse to counts. No job row changes (FR-011).

## `POST /api/guides/{kind}/discard`

- **Body:** `{ proposalId: number }`.
- **404** as approve, when it isn't the caller's current proposal.
- **200 `{ proposal: null }`**: the proposal is deleted. The approved version is unchanged (US4 AS2).

## `/brand` page

- **Load:** `requireArtist(locals.user)`, then `{ voice: GuideState<VoiceRules>, brand: GuideState<BrandGuide> }`. A future `limitUntil` shows the quota wait on load.
- **Menu:** "Brand" for every signed-in user with a profile.
- **Voice section:**
  - Approved: the rules, plus "Carried over from your earlier rules" when `carriedOver`, else "From N uploads, D Soundboard drafts, M edits and K approvals, proposed <date>". None: "Not set. Drafts use plain, generic rules."
  - Proposal:
    - the source list in two groups, "Written by you" and "Approved Soundboard drafts", each upload's title and date linked to its watch page
    - the edit and approval counts, and the thin-evidence line when `thin`
    - one textarea with one rule per line, and Approve / Discard
- **Brand guide section:** today's statement and keep / fix / drop editor, with its upload list. None approved: "Not set. Drafts run without one."
- **Waits and errors:** the button shows the wait text while polling. On a 404 from approve or discard, the message shows and the edited text stays in the form.
- Labels are plain (constitution II). No persona copy.

## `revokeGrant` and `markRevoked` (connection behavior)

- Both delete the caller's artist's proposals (voice and brand) in the same transaction as the connection write, after it. Approved guides are untouched.

## `POST /api/jobs/{id}/step` (pick behavior)

- An artist job reads the owner's approved voice and brand guide when the pick runs. No approved voice → `GENERIC_VOICE`. No approved brand → no brand block.
- The prompt carries the content-rules line after the voice block on every run (research R7).
- Re-runs read the current approved versions.
- The hook pick reads the owner's current approved voice for its `reason`; no approved voice → today's hook prompt.
- A Short's title, description and tags are its parent's approved fields, copied unchanged (FR-007 as clarified, FR-011).

## Retention job

- `functions/genrecleanup.ts` → `handleGenreCleanup` runs both deletes as `soundboard_cleanup` and answers `{ "deleted": <job_audience rows>, "proposals": <artist_guides rows> }`. Proposals go at 29 days. Any failure → 500. Same trigger, same slug.

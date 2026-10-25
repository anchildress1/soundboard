# Contract: artist profile

Interfaces this feature adds or changes. Shapes are in [data-model.md](../data-model.md); reasoning in [research.md](../research.md).

## `PUT /api/artist`

Creates the caller's profile, or updates it. The first-run form on `/new` and the Artist section on `/settings` both use it.

- **Auth:** a session is required. Signed out → `401 "Sign in first."`, nothing written.
- **Body:** `{ "name": string, "bandcampUrl": string, "contactLine": string }`.
  - All three are always sent. The forms are pre-filled, so an untouched optional field resubmits its stored value.
  - Absent fields read as `""`, and empty optional fields store null.
- **Validation:** `parseArtist` (research R11).
  - Error → `422 { "error": "Fix the highlighted fields.", "fields": { "name"?, "bandcampUrl"?, "contactLine"? } }`. Nothing is written, and the old values stay.
- **No profile yet:** `soundboard_create_artist`. On `23505` (a concurrent create), retry once as an update.
- **Has a profile:** `UPDATE artists … WHERE id = <caller's artist_id>`, through RLS.
- **200:** `{ "artist": { "name", "bandcampUrl", "contactLine" } }`. Never `id` or `curated`, and both are ignored if sent.
- **Types:** `ActionError.fields` widens to `FieldErrors | ArtistFieldErrors`. `src/lib/api.ts` gains `saveArtist(body)`.

## `POST /api/jobs` and `POST /api/jobs/{id}/short` (changed)

- **No profile:** `locals.user.artist === null` → `409 "Add your artist name first."`, checked before signing or creating anything.
- **Job's `artist_id`:** set to `locals.user.artist.id`. `jobs_insert` rejects anything else.
- **Short creation** (R7):
  - `artistName` is the owner's current profile name.
  - Tags are the parent's approved tags with the parent pick's `artistName` removed (case-insensitive), with the current name first.
  - The parent's fields are unchanged.

## `POST /api/jobs/{id}/step`, pick step (changed)

Checks run in this order, all before any model call:

1. **Owner has no profile:** `{ wait: 'Add your artist name first.' }`.
2. **Identity read:** `getConnection` → `accessTokenFor(owner, channelId, deadline)` → `ownUploads(token, channelId, 3, deadline)`.
   - `access-lost` → `{ wait: 'reconnect YouTube' }`. A live token is marked refused.
   - `busy` → `{ wait: 'waiting on YouTube' }`. The grant is untouched.
   - `app-rejected` → the step fails (counts toward `consecutiveFailures`).
3. **Model call and stored pick:** the stored pick carries `artistName`.
   - The description and `bandcamp.credits` end with the owner's `contactLine` when set, placed in code.
   - No YouTube-sourced text from the read is stored, and none reaches Sentry.

## `POST /api/jobs/{id}/approve` (changed validation)

- **Allowed tags:** the job's candidates plus `pick.artistName`.
- **Artist tag:**
  - It must be present exactly once when `pick.artistName` isn't null. Otherwise → `422 tags: "Keep the artist tag: <name>."`
  - It's exempt from the song-title rule.

## Brand guide: `/brand`, `POST /api/brand/{propose,approve,discard}`

- **Gate:** `requireCurated(locals.user)` → 404 unless `locals.user.artist?.curated`.
- **Propose:** `ownUploads(token, channelId, BRAND_VIDEOS, deadline)` through the caller's grant.
  - `access-lost` → `{ wait: 'reconnect YouTube' }`.
  - `busy` → `{ wait: 'waiting on YouTube' }`.
  - `app-rejected` → error.
  - Zero uploads → the existing `409`.
- **Stored proposal:** keeps `uploadCount`, not video IDs.
- **Memory:** keyed by `locals.user.artist.id`.

## Page data and screens

- **`+layout.server.ts`:** `artist: { name, bandcampUrl, curated } | null`. Signed out it's null, and no artist value reaches the page.
- **`/new`:** no profile → `ArtistForm` (heading "Who's the artist?", fields Artist name, Bandcamp URL, Contact line, button Save). Once saved, `invalidateAll()` shows the new-release form.
- **`/settings`:**
  - The loader returns the owner's editable `artist: { name, bandcampUrl, contactLine } | null`, from `locals.user.artist` only.
  - The Artist section shows `ArtistForm`, pre-filled, with the button "Save changes", then "Saved." and `invalidateAll()`.
  - Peer influence follows.
- **Bandcamp screen:**
  - `Bandcamp.svelte` takes `bandcampUrl: string | null`. Set → the editor link is `${bandcampUrl}/edit_track`.
  - Null → no link. The note "Add your Bandcamp URL in Settings" links to `/settings`, and the copy fields stay.
- **Review, Tags step:** `pick.artistName` shows as a fixed tag outside the editable field, included in the counter and in the submit.
- **Working screen:** `'Add your artist name first.'` shows with a link to Settings. `'reconnect YouTube'` during the pick shows with a link to Connections.

## Operator script

- `scripts/invite.ts`: unchanged. Its usage example `--artist flr` stays valid.

# Contract: artist profile

Interfaces this feature adds or changes. Shapes are in [data-model.md](../data-model.md), and the reasoning is in [research.md](../research.md).

## `PUT /api/artist`

Creates the caller's profile, or updates it. The first-run form on `/new` and the form on `/settings` both use it.

- **Auth:** a session is required. Signed out → `401 "Sign in first."`, and nothing is written.
- **Body:** `{ "name": string, "bandcampUrl": string, "contactLine": string }`. Absent fields are read as `""`, and empty optional fields store null.
- **Validation:** `parseArtist` in `src/lib/artist.ts` (research R9).
  - Any error → `422 { "error": "Fix the highlighted fields.", "fields": { "name"?: string, "bandcampUrl"?: string, "contactLine"?: string } }`, and nothing is written. The old values stay (US4 AS3).
- **No profile yet:** `soundboard_create_artist`.
  - It raises `23505` when a concurrent request created the profile first. The handler then retries once as an update.
- **Has a profile:** `UPDATE artists SET name, bandcamp_url, contact_line, updated_at = now() WHERE id = <caller's artist_id>`, through RLS.
- **200:** `{ "artist": { "name": string, "bandcampUrl": string | null, "contactLine": string | null } }`.
- **Never** returns or accepts `id` or `curated`.
- **Type change:** `ActionError.fields` widens from `FieldErrors` to `FieldErrors | ArtistFieldErrors`. `src/lib/api.ts` gets `saveArtist(body)` through the existing `call`.

## `POST /api/jobs` (changed)

- `locals.user.artist === null` → `409 "Add your artist name first."`, checked before signing an upload URL. No job is created (FR-003 AS4).
- The job's `artist_id` is `locals.user.artist.id`. The `jobs_insert` policy rejects anything else (R14).

## `POST /api/jobs/{id}/short` (changed)

- Same `409` when the caller has no profile.

## `POST /api/jobs/{id}/step` (changed behavior)

- **Pick step:**
  - The owner has no profile → `{ wait: 'Add your artist name first.' }`. No YouTube or model call runs (R13).
  - Otherwise the stored pick carries `artistName` (the owner's profile name at that moment) and `uploadsRead`.

## `POST /api/jobs/{id}/approve` (changed validation)

- Allowed tags are the job's tag candidates plus `pick.artistName` when it isn't null (R7). It's no longer a constant.

## Brand guide: `/brand`, `POST /api/brand/{propose,approve,discard}`

- **Gate:** `requireCurated(locals.user)` → 404 unless `locals.user.artist?.curated` is true. It replaces `requireArtist`.
- **Propose:** reads the owner's own uploads through their grant (`ownUploads`, R6).
  - Not connected → `409 "Connect YouTube to read your channel."`
  - Zero uploads → the existing `409`.
- **Storage:** memory rows are keyed by `locals.user.artist.id`.

## Page data

- **`+layout.server.ts`** returns `artist: { name, bandcampUrl, curated } | null` beside `user` and `channel`. Signed out, `artist` is null and no artist value reaches the page (FR-009, SC-006).
- **`/new`:** no profile → the artist form (heading "Who's the artist?", fields Artist name, Bandcamp URL, Contact line, button Save). Once saved, `invalidateAll()` brings up the new-release form (US1 AS1, AS3).
- **`/settings`:** open to every signed-in user.
  - An **Artist** section holds the same form, pre-filled, with the button "Save changes", followed by the existing Peer influence section.
  - A saved edit shows "Saved." (US4).
- **Job page, Bandcamp screen:** `Bandcamp.svelte` takes `bandcampUrl: string | null`.
  - Set → the editor link opens `new URL('/edit_track', bandcampUrl)`.
  - Null → no link, and the note "Add your Bandcamp URL in Settings" links to `/settings`. The copy fields stay (US3 AS2).
- **Review, Description step:** `uploadsRead === false` → one plain line under Why this: "Drafted without your recent uploads." (US2 AS4).
- **Working screen:** the wait `'Add your artist name first.'` shows as text, plus a link to Settings.

## Operator script

- `scripts/invite.ts`: no change to its commands. The usage comment's example `--artist flr` stays valid, because `flr` now exists in `artists`.
- A link to a missing profile fails on the foreign key, with the database's error printed as it is today.

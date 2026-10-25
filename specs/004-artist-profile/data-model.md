# Data model: Artist profile

Source of truth after implementation: `src/lib/server/core/schema.ts` and the generated migration in `drizzle/`. Rationale is in [research.md](research.md).

## `artists` (new table)

| Column         | Type          | Rules                                                                                                                          |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`           | `text` PK     | `flr` for Nathan (migration). New profiles: `gen_random_uuid()::text` inside `soundboard_create_artist`.                       |
| `name`         | `text` NN     | `name = btrim(name)`, `char_length(name) between 1 and 100`, `name !~ '[<>,]'`, `name !~ '^#'` (FR-004)                        |
| `bandcamp_url` | `text` null   | null, or `~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?\.bandcamp\.com$'` (normalized origin, R11)                                 |
| `contact_line` | `text` null   | null, or `contact_line = btrim(contact_line)`, `char_length between 1 and 200`, `!~ '[<>#]'`                                   |
| `curated`      | `boolean` NN  | default `false`. `true` only for `flr`, set by the migration. The app has no grant on it. **Spec 005 drops this column** (R4). |
| `created_at`   | `timestamptz` | default `now()`                                                                                                                |
| `updated_at`   | `timestamptz` | default `now()`; the app sets it on every edit                                                                                 |

- **RLS** `artists_owner`, `FOR SELECT` and `FOR UPDATE` `TO soundboard_app`, `USING`/`WITH CHECK`:
  `id = (select u.artist_id from public.users u where u.uid = <principal> and u.active)`
- **Grants:** `SELECT`, `UPDATE (name, bandcamp_url, contact_line, updated_at)` to `soundboard_app`. No `INSERT` or `DELETE`.
- **Force RLS**, like every other table.

## `users` (changed)

- `artist_id` → `REFERENCES artists(id)`, plus `UNIQUE` (FR-001). The app still has no `UPDATE` on `users`.
- `scripts/invite.ts add <email> --artist <id>` stays: it only attaches an invite to an existing profile.

## `jobs` (changed)

- `artist_id` → `REFERENCES artists(id)`. No new column.
- `jobs_insert` top-level branch: `parent_id is null and artist_id is not null and artist_id = (select u.artist_id …)`.
- `picks` JSON: every element gains `artistName` (backfilled, R3 step 4).
- **Shorts:** keep the parent's `artist_id`, null included (`soundboard_owns_job`, unchanged). Only `artistName` comes from the owner's current profile (R7).

## `artist_memory` (changed)

- `artist_id` → `REFERENCES artists(id)`.
- `flr` facts: `artist-name` deleted (derived), `home` and `mr-kill` ensured.
- `brand` rows: `basedOn` (video IDs) → `uploadCount` (R13).

## Function `soundboard_create_artist(p_name text, p_bandcamp text, p_contact text) RETURNS SETOF public.artists`

- `SECURITY DEFINER`, `SET search_path = pg_catalog, public`. `EXECUTE` to `soundboard_app` only.
- `42501`: no `app.user_sub`, or no active user for it.
- `23505` (`'Artist profile exists'`): the caller already has an `artist_id`.
- Otherwise it inserts (the `CHECK`s validate), sets `users.artist_id`, and returns the row.

## Migration data block (R3)

Runs after `CREATE TABLE artists` and before the foreign keys and unique constraint:

1. Insert `flr`: `Flies Like Robots`, `https://flieslikerobots.bandcamp.com`, `Contact at flieslikerobots@gmail.com.`, `curated = true`.
2. `flr` facts, `ON CONFLICT DO NOTHING`:
   - `home`: `{"key":"home","value":"Virginia","kind":"FACT","public":true}`
   - `mr-kill`: `{"key":"mr-kill","value":"Connected to the artist Mr. Kill","kind":"INFERENCE","public":false}`
3. Delete the `flr` fact keyed `artist-name`.
4. Every job with picks: each element `|| jsonb_build_object('artistName', <'Flies Like Robots' when artist_id = 'flr' else null>)`, order kept (`with ordinality`).
5. `kind = 'brand'` rows with `basedOn`: `(data - 'basedOn') || jsonb_build_object('uploadCount', jsonb_array_length(data->'basedOn'))`.

## TypeScript shapes

- **`ArtistProfile`** (`src/lib/server/artist/profile.ts`): `{ id; name; bandcampUrl: string | null; contactLine: string | null; curated: boolean }`
- **`ArtistInput`** (`src/lib/artist.ts`): `{ name: string; bandcampUrl: string; contactLine: string }`. `parseArtist` normalizes, and empty optional fields become null.
- **`App.Locals['user']`:** `{ uid; sid; email; artist: ArtistProfile | null }`. `artistId` is removed.
- **`Pick`:** gains `artistName: string | null`, the name the pick or Short used. Null only on backfilled pre-profile picks.
- **`StoredBrand`** (`src/lib/brand.ts`): `basedOn: string[]` → `uploadCount: number`.
- **`Wait`:** gains `'Add your artist name first.'`. `'reconnect YouTube'` and `'waiting on YouTube'` are reused (R8).
- **`PickContext` / `PickFixups`:** `artist: boolean` → `artist: { name; contactLine; curated }` and `memory: boolean`.
- **`Part`** (`core/tracing.ts`): the text part gains an optional `source: 'youtube'` that `redactTurns` replaces with a placeholder.
- **YouTube platform:**
  - `budgetSignal(deadline): AbortSignal`, throwing `DeadlineSpent` when no time remains (R14)
  - `ownUploads(token, channelId, count, deadline)`
  - `thumbnailImage(url, deadline)`, `keyGet(path, query, deadline)`, `audienceEvidence(chunks, durationSec, deadline)`
  - `identityFailure(error): 'access-lost' | 'busy' | 'app-rejected'`
  - `accessTokenFor(uid, channelId, deadline)`
- **Model:** `hasModelTime(agent, deadline): boolean` in `ai/model.ts`.
- **Layout data:** `artist: { name; bandcampUrl; curated } | null`.
- **Settings data (owner only):** `artist: { name; bandcampUrl; contactLine } | null`.

## Lifecycle

- **No profile → profile:** only through `soundboard_create_artist`. Nothing deletes a profile.
- **Edits:** they apply to the next pick and the next Short only. Stored picks, `finalFields` and published videos never change (FR-011).
- **Grant revoked or disconnected:** identity and brand reads stop, and picks wait on `reconnect YouTube`. Nothing YouTube-sourced from identity is stored to delete.

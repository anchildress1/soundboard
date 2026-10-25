# Data model: Artist profile

Source of truth after implementation: `src/lib/server/core/schema.ts` and the generated migration in `drizzle/`. Rationale for each choice is in [research.md](research.md).

## `artists` (new table)

| Column         | Type          | Rules                                                                                                    |
| -------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| `id`           | `text` PK     | `flr` for Nathan (migration). New profiles: `gen_random_uuid()::text` inside `soundboard_create_artist`. |
| `name`         | `text` NN     | `name = btrim(name)`, `char_length(name) between 1 and 100`, `name !~ '[<>]'` (FR-004)                   |
| `bandcamp_url` | `text` null   | null, or `~ '^https://'` and `char_length ≤ 2000`. Full parse in `src/lib/artist.ts` (R9).               |
| `contact_line` | `text` null   | null, or `contact_line = btrim(contact_line)`, `char_length between 1 and 200`, `!~ '[<>]'`              |
| `curated`      | `boolean` NN  | default `false`. `true` only for `flr`, set by the migration. The app has no grant on it (R4).           |
| `created_at`   | `timestamptz` | default `now()`                                                                                          |
| `updated_at`   | `timestamptz` | default `now()`. The app sets it on every edit.                                                          |

- **RLS** `artists_owner`, `FOR SELECT` and `FOR UPDATE` `TO soundboard_app`, `USING`/`WITH CHECK`:
  `id = (select u.artist_id from public.users u where u.uid = <principal> and u.active)`
- **Grants:** `SELECT`, `UPDATE (name, bandcamp_url, contact_line, updated_at)` to `soundboard_app`. No `INSERT` or `DELETE`. Creating a profile goes only through the function below.
- **Force RLS**, like every other table (`0004`).

## `users` (changed)

- `artist_id` → `REFERENCES artists(id)`, plus `UNIQUE` (nulls distinct). At most one profile per user, never shared (FR-001).
- The app still has no `UPDATE` on `users`.
- `scripts/invite.ts add <email> --artist <id>` stays: the operator path that links an invite to an existing profile (Nathan in a fresh environment).

## `jobs` (changed)

- `artist_id` → `REFERENCES artists(id)`. No new column (R15).
- `jobs_insert` policy, top-level branch: `parent_id is null and artist_id is not null and artist_id = (select u.artist_id …)` (R14). The Short branch is unchanged.
- `picks` JSON: every element gains `artistName` and `uploadsRead` (backfilled, R7).

## `artist_memory` (changed)

- `artist_id` → `REFERENCES artists(id)`.
- The `fact` rows for `flr` lose `artist-name` (derived now) and gain `home` and `mr-kill` if they aren't there yet (R3, R5).
- Policies unchanged.

## Function `soundboard_create_artist(p_name text, p_bandcamp text, p_contact text) RETURNS SETOF public.artists`

- `SECURITY DEFINER`, `SET search_path = pg_catalog, public`. `EXECUTE` is granted only to `soundboard_app`.
- Raises `42501` when `app.user_sub` is missing, or names no active user.
- Raises `23505` (`'Artist profile exists'`) when the caller's row already has an `artist_id`.
- Otherwise it inserts the row (table `CHECK`s validate it), sets `users.artist_id`, and returns the row.

## Migration data block (R3)

Runs inside the generated migration, after `CREATE TABLE artists` and before the foreign keys:

1. Insert `flr`: `Flies Like Robots`, `https://flieslikerobots.bandcamp.com`, `Contact at flieslikerobots@gmail.com.`, `curated = true`.
2. `artist_memory` facts for `flr`, `ON CONFLICT DO NOTHING`:
   - `home`: `{"key":"home","value":"Virginia","kind":"FACT","public":true}`
   - `mr-kill`: `{"key":"mr-kill","value":"Connected to the artist Mr. Kill","kind":"INFERENCE","public":false}`
3. Delete the `flr` fact with key `artist-name`.
4. `UPDATE jobs SET picks = (select jsonb_agg(p || jsonb_build_object('artistName', <'Flies Like Robots' when artist_id = 'flr' else null>, 'uploadsRead', false) order by ord) from jsonb_array_elements(picks) with ordinality …) WHERE jsonb_array_length(picks) > 0`

## TypeScript shapes

- **`ArtistProfile`** (`src/lib/server/artist/profile.ts`): `{ id: string; name: string; bandcampUrl: string | null; contactLine: string | null; curated: boolean }`
- **`ArtistInput`** (`src/lib/artist.ts`): `{ name: string; bandcampUrl: string; contactLine: string }`. Empty strings become null after `parseArtist`.
- **`App.Locals['user']`:** `{ uid; sid; email; artist: ArtistProfile | null }`. `artistId` is removed; callers read `artist?.id`.
- **`Pick`** (`src/lib/types.ts`), new fields:
  - `artistName: string | null`: the profile name the pick used. Null only on backfilled pre-profile picks.
  - `uploadsRead: boolean`: whether the pick read the owner's recent uploads (US2 AS4).
- **`Wait`** gains `'Add your artist name first.'` (R13).
- **`PickContext` / `PickFixups`:** `artist: boolean` is replaced by:
  - `artist: { name: string; contactLine: string | null; curated: boolean }`
  - `memory: boolean` (= `artistJob`: facts from storage, feedback, brand, identity)
- **Layout data:** `artist: { name: string; bandcampUrl: string | null; curated: boolean } | null`

## State and lifecycle

- **No profile → profile:** one way only, through `soundboard_create_artist`. Nothing deletes a profile.
- **Edits:** they apply to the next pick only. Stored picks, `finalFields` and published videos never change (FR-011).
- **Connected channel changes:** identity reads follow the current connection. `jobs.destination_channel_id` stays pinned (spec 001).

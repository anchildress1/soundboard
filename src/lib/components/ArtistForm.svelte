<script lang="ts">
  import { ApiError, saveArtist } from '#lib/api.js';
  import { CONTACT_MAX, NAME_MAX, type ArtistFieldErrors, type ArtistValue } from '#lib/artist.js';

  let {
    initial = null,
    submitLabel,
    savedText = '',
    onsaved,
  }: {
    /** The stored profile; every field is pre-filled, so an untouched one resubmits as stored. */
    initial?: ArtistValue | null;
    submitLabel: string;
    /** Shown after a save until the next submit. */
    savedText?: string;
    onsaved: (artist: ArtistValue) => void | Promise<void>;
  } = $props();

  // The form edits its own copy; the stored profile only seeds it.
  // svelte-ignore state_referenced_locally
  let name = $state(initial?.name ?? '');
  // svelte-ignore state_referenced_locally
  let bandcampUrl = $state(initial?.bandcampUrl ?? '');
  // svelte-ignore state_referenced_locally
  let contactLine = $state(initial?.contactLine ?? '');
  let errors = $state<ArtistFieldErrors>({});
  let message = $state('');
  let saved = $state(false);
  let busy = $state(false);

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    busy = true;
    errors = {};
    message = '';
    saved = false;
    try {
      const { artist } = await saveArtist({ name, bandcampUrl, contactLine });
      saved = true;
      await onsaved(artist);
    } catch (error) {
      if (error instanceof ApiError) {
        errors = error.fields ?? {};
        message = error.message;
      } else {
        message = "Couldn't save. Try again.";
      }
    } finally {
      busy = false;
    }
  };
</script>

<form onsubmit={save} aria-label="Artist" novalidate>
  <div class="field" class:err={errors.name}>
    <label for="artist-name">Artist name</label>
    <input
      id="artist-name"
      bind:value={name}
      maxlength={NAME_MAX}
      autocomplete="off"
      required
      disabled={busy}
      aria-invalid={errors.name ? 'true' : undefined}
      aria-describedby={errors.name ? 'artist-name-msg' : undefined}
    />
    {#if errors.name}<span class="msg" id="artist-name-msg">{errors.name}</span>{/if}
  </div>
  <div class="field" class:err={errors.bandcampUrl}>
    <label for="artist-bandcamp">Bandcamp URL <span>optional</span></label>
    <input
      id="artist-bandcamp"
      type="url"
      bind:value={bandcampUrl}
      placeholder="https://<name>.bandcamp.com"
      autocomplete="url"
      disabled={busy}
      aria-invalid={errors.bandcampUrl ? 'true' : undefined}
      aria-describedby={errors.bandcampUrl ? 'artist-bandcamp-msg' : undefined}
    />
    {#if errors.bandcampUrl}<span class="msg" id="artist-bandcamp-msg">{errors.bandcampUrl}</span
      >{/if}
  </div>
  <div class="field" class:err={errors.contactLine}>
    <label for="artist-contact">Contact line <span>optional</span></label>
    <input
      id="artist-contact"
      bind:value={contactLine}
      maxlength={CONTACT_MAX}
      autocomplete="off"
      disabled={busy}
      aria-invalid={errors.contactLine ? 'true' : undefined}
      aria-describedby={errors.contactLine ? 'artist-contact-msg' : 'artist-contact-help'}
    />
    {#if errors.contactLine}
      <span class="msg" id="artist-contact-msg">{errors.contactLine}</span>
    {:else}
      <span class="msg" id="artist-contact-help">Added to the end of every draft as written.</span>
    {/if}
  </div>
  <div class="actions">
    <button class="btn primary" type="submit" disabled={busy}>{submitLabel}</button>
  </div>
  <p class="toast" class:err={message} aria-live="polite">{message || (saved ? savedText : '')}</p>
</form>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
</style>

<script lang="ts">
  import { untrack } from 'svelte';
  import {
    splitTags,
    tagsLength,
    TAGS_MAX,
    TITLE_MAX,
    validateFields,
    type FieldErrors,
  } from '#lib/metadata.js';
  import type { Destination, PickFields } from '#lib/types.js';

  type Fields = { title: string; description: string; tags: string[] };

  let {
    fields,
    candidates,
    editable,
    busy = false,
    done = false,
    serverErrors = {},
    destination,
    uploaded = false,
    discardable = false,
    idPrefix = '',
    heading = 'YouTube',
    rerunLabel = 'Re-run model',
    onapprove,
    onrerun,
    ondiscard,
  }: {
    fields: PickFields;
    candidates: string[];
    editable: boolean;
    busy?: boolean;
    done?: boolean;
    serverErrors?: FieldErrors;
    /**
     * The channel this label uploads to: the one approval pinned, else in review the owner's
     * connected channel. Shown whenever set; null in review blocks approval.
     */
    destination: Destination | null;
    /** YouTube holds the video, so the channel line reads in the past tense. */
    uploaded?: boolean;
    /** A publish paused on lost access or an unknown outcome can still be discarded. */
    discardable?: boolean;
    /** Keeps field ids unique when two labels share a page. */
    idPrefix?: string;
    heading?: string;
    rerunLabel?: string;
    onapprove: (fields: Fields) => void;
    onrerun: () => void;
    ondiscard: () => void;
  } = $props();

  // The parent remounts this component per recommendation, so the initial values are the draft.
  let title = $state(untrack(() => fields.title));
  let description = $state(untrack(() => fields.description));
  let tagsText = $state(untrack(() => fields.tags.join(', ')));

  const tags = $derived(splitTags(tagsText));
  const tagCount = $derived(tagsLength(tags));
  const errors = $derived({
    ...serverErrors,
    ...validateFields({ title, description, tags }, candidates),
  });
  const invalid = $derived(Object.keys(errors).length > 0);
</script>

<section class="youtube" aria-labelledby="{idPrefix}youtube-title">
  <h2 id="{idPrefix}youtube-title">{heading}</h2>
  <div class="fields">
    <div class="field" class:err={errors.title}>
      <label for="{idPrefix}title">Title <span>{title.length} / {TITLE_MAX}</span></label>
      <input
        id="{idPrefix}title"
        bind:value={title}
        maxlength={TITLE_MAX}
        autocomplete="off"
        readonly={!editable}
      />
      {#if errors.title}<span class="msg">{errors.title}</span>{/if}
    </div>
    <div class="field" class:err={errors.description}>
      <label for="{idPrefix}desc">Description <span>model draft</span></label>
      <textarea id="{idPrefix}desc" rows="7" bind:value={description} readonly={!editable}
      ></textarea>
      {#if errors.description}<span class="msg">{errors.description}</span>{/if}
    </div>
    <div class="field" class:err={errors.tags}>
      <label for="{idPrefix}tags">Tags <span>{tagCount} / {TAGS_MAX}</span></label>
      <textarea id="{idPrefix}tags" rows="3" bind:value={tagsText} readonly={!editable}></textarea>
      <span class="msg"
        >{errors.tags ?? 'Plain terms, comma-separated. Hashtags live in the description.'}</span
      >
    </div>
    <div class="field">
      <span class="label">Visibility</span>
      <p class="fixed">Private</p>
    </div>
  </div>

  {#if destination}
    <p class="channel">
      {uploaded ? 'Uploaded to' : 'Uploads to'}
      <strong>{destination.channelTitle ?? 'your channel'}</strong>
      <span>{destination.channelId}</span>
    </p>
  {:else if editable}
    <p class="channel">Reconnect YouTube to approve.</p>
  {/if}
  {#if editable || done}
    <div class="actions">
      <button
        class="btn danger small"
        type="button"
        onclick={ondiscard}
        disabled={busy || (done && !discardable)}>Discard</button
      >
      <button class="btn" type="button" onclick={onrerun} disabled={busy || done}
        >{rerunLabel}</button
      >
      <button
        class="btn primary"
        type="button"
        disabled={busy || done || invalid || !destination}
        onclick={() => onapprove({ title, description, tags })}
        >{done ? 'Uploaded' : 'Approve & upload'}</button
      >
    </div>
  {/if}
</section>

<style>
  .youtube {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
  }

  .fields {
    display: grid;
    gap: 18px;
  }

  .fixed {
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-control);
    background: var(--panel);
  }

  .channel {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    font-size: 15px;
    overflow-wrap: anywhere;
  }

  .channel span {
    color: var(--muted);
  }

  /* Secondary actions left, the one primary right. */
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  .actions :global(.primary) {
    margin-left: auto;
  }

  @media (width < 560px) {
    .actions > :global(.btn) {
      flex: 1;
    }

    .actions :global(.primary) {
      flex-basis: 100%;
      order: -1;
      margin-left: 0;
    }
  }
</style>

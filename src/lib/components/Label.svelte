<script lang="ts">
  import { untrack } from 'svelte';
  import {
    splitTags,
    tagsLength,
    TAGS_MAX,
    TITLE_MAX,
    validateFields,
    type FieldErrors,
  } from '$lib/metadata';
  import type { PickFields } from '$lib/types';

  type Fields = { title: string; description: string; tags: string[] };

  let {
    fields,
    candidates,
    editable,
    busy = false,
    done = false,
    serverErrors = {},
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
      <textarea id="{idPrefix}tags" class="mono" rows="2" bind:value={tagsText} readonly={!editable}
      ></textarea>
      <span class="msg"
        >{errors.tags ?? 'Plain terms, comma-separated. Hashtags live in the description.'}</span
      >
    </div>
    <div class="field">
      <span class="label">Visibility</span>
      <p class="fixed">Private</p>
    </div>
  </div>

  {#if editable || done}
    <div class="actions">
      <button class="btn ghost" type="button" onclick={ondiscard} disabled={busy || done}
        >Discard</button
      >
      <button class="btn ghost" type="button" onclick={onrerun} disabled={busy || done}
        >{rerunLabel}</button
      >
      <button
        class="btn primary"
        class:done
        type="button"
        disabled={busy || done || invalid}
        onclick={() => onapprove({ title, description, tags })}
        >{done ? 'Uploaded' : 'Approve & upload'}</button
      >
    </div>
  {/if}
</section>

<style>
  /* Same panel and heading as the Bandcamp tab, so the two destinations read alike. */
  .youtube {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    background: var(--panel);
    padding: 12px 14px;
  }

  h2 {
    margin: 0;
    font: 900 12px/1.2 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--orange);
  }

  .fields {
    display: grid;
    gap: 14px;
  }

  .fixed {
    margin: 0;
    padding: 10px 12px;
    background: var(--well);
    border: 1px solid var(--line);
    font: 500 13px/1.5 var(--mono);
  }

  /* One group, always together: right-aligned on wide screens, one block on phones. */
  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: flex-end;
    border-top: 1px solid var(--line);
    padding-top: 16px;
  }

  @media (max-width: 520px) {
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }

    .actions :global(.primary) {
      grid-column: 1 / -1;
      order: -1;
    }
  }
</style>

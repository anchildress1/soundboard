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
    name = 'What goes to YouTube',
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
    name?: string;
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

<section class="label" aria-label={name}>
  <div class="bubble" class:err={errors.title}>
    <label for="{idPrefix}title">Title</label>
    <span class="count">{title.length} / {TITLE_MAX}</span>
    <input
      id="{idPrefix}title"
      bind:value={title}
      maxlength={TITLE_MAX}
      autocomplete="off"
      readonly={!editable}
    />
    {#if errors.title}<span class="bubble-msg">{errors.title}</span>{/if}
  </div>

  <div class="fields">
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
      <button class="btn danger" type="button" onclick={ondiscard} disabled={busy || done}
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
  .label {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }

  .bubble {
    position: relative;
    background: var(--bubble);
    color: var(--bubble-ink);
    padding: 16px 18px 14px;
    border-radius: 22px;
    border: 3px solid var(--bubble-ink);
    box-shadow: 4px 4px 0 var(--magenta);
    margin-bottom: 8px;
  }

  .bubble.err {
    box-shadow: 4px 4px 0 var(--red-text);
  }

  .bubble::after {
    content: '';
    position: absolute;
    left: 34px;
    bottom: -18px;
    border: 9px solid transparent;
    border-top-color: var(--bubble-ink);
    border-bottom: 0;
  }

  .bubble::before {
    content: '';
    position: absolute;
    left: 36px;
    bottom: -11px;
    border: 7px solid transparent;
    border-top-color: var(--bubble);
    border-bottom: 0;
    z-index: 1;
  }

  .bubble label {
    display: block;
    font: 900 11px/1 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin-bottom: 8px;
  }

  .bubble input {
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--bubble-ink);
    font: 900 clamp(17px, 2.2vw, 22px) / 1.2 var(--display);
    padding: 0;
    outline: none;
  }

  .bubble input:focus-visible {
    box-shadow: 0 2px 0 var(--magenta);
  }

  .count {
    position: absolute;
    right: 16px;
    top: 14px;
    font: 500 11px/1 var(--mono);
    color: #5e5952;
  }

  .bubble-msg {
    display: block;
    margin-top: 6px;
    font-size: 12px;
    color: var(--red);
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

  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    border-top: 1px solid var(--line);
    padding-top: 16px;
  }

  .actions :global(.danger) {
    margin-right: auto;
  }
</style>

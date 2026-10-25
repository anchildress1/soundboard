<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { loadDraft, saveDraft } from '#lib/draft.js';
  import {
    DESCRIPTION_MAX,
    parseHashtags,
    splitTags,
    tagsLength,
    TAGS_MAX,
    TITLE_MAX,
    validateFields,
    type FieldErrors,
  } from '#lib/metadata.js';
  import {
    nextReviewStep,
    previousReviewStep,
    REVIEW_STEPS,
    type ReviewStep,
  } from '#lib/release.js';
  import { citationText, type FieldName, type ReviewData } from '#lib/review.js';
  import type { Destination, Pick, PickFields } from '#lib/types.js';

  type Fields = { title: string; description: string; tags: string[] };

  let {
    fields,
    pick,
    candidates,
    destination,
    draft,
    busy = false,
    serverErrors = {},
    step = $bindable('title'),
    sources,
    summary,
    onapprove,
    onrerun,
    ondiscard,
  }: {
    /** The model's draft to start from. */
    fields: PickFields;
    pick: Pick;
    candidates: string[];
    /** The owner's connected channel; null blocks approval until YouTube is reconnected. */
    destination: Destination | null;
    /** Storage key for this pick's edits; the parent clears it once approval lands. */
    draft: string;
    busy?: boolean;
    serverErrors?: FieldErrors;
    step?: ReviewStep;
    /** The sources behind each field, when the pick has any to show. */
    sources?: ReviewData['sources'];
    /** What the Approve screen adds under its facts: recommendation, peers. */
    summary?: Snippet;
    onapprove: (fields: Fields) => void;
    onrerun: () => void;
    ondiscard: () => void;
  } = $props();

  // The parent remounts this component per pick, so the initial values are the draft or saved edits.
  const saved = untrack(() => loadDraft(draft));
  let title = $state(saved?.title ?? untrack(() => fields.title));
  let description = $state(saved?.description ?? untrack(() => fields.description));
  // The artist tag is fixed, outside the editable field, so editing can't drop it (research R9).
  const artistName = untrack(() => pick.artistName);
  const artistKey = artistName?.toLowerCase();
  const editable = (list: string[]) => list.filter((tag) => tag.toLowerCase() !== artistKey);
  let tagsText = $state(saved?.tags ?? untrack(() => editable(fields.tags).join(', ')));
  if (saved && (REVIEW_STEPS as readonly string[]).includes(saved.step)) {
    step = saved.step as ReviewStep;
  }

  const tags = $derived(
    artistName ? [artistName, ...editable(splitTags(tagsText))] : splitTags(tagsText),
  );
  const tagCount = $derived(tagsLength(tags));
  const errors = $derived({
    ...serverErrors,
    ...validateFields({ title, description, tags }, candidates),
  });
  const hasFlags = $derived(pick.flags.length > 0);
  const firstError = $derived(
    (['title', 'description', 'tags'] as const).find((field) => errors[field]),
  );

  $effect(() => saveDraft(draft, { title, description, tags: tagsText, step }));

  // A rejected approval lands on the first field the server refused.
  $effect(() => {
    const field = (['title', 'description', 'tags'] as const).find((f) => serverErrors[f]);
    if (field) untrack(() => (step = field));
  });

  const next = () => (step = nextReviewStep(step, hasFlags));
  const back = () => (step = previousReviewStep(step, hasFlags));
  const approve = () => onapprove({ title, description, tags });
</script>

{#snippet why(text: string, field: FieldName)}
  {@const cited = sources?.[field] ?? []}
  {#if text}
    <div class="why">
      <h2>Why this</h2>
      <p class="help">{text}</p>
      {#if cited.length > 0}
        <p class="help">
          Sources:
          {#each cited as citation, i (citation.ref)}{i > 0 ? '; ' : ''}{citationText(
              citation,
            )}{/each}
        </p>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet rerun()}
  <button class="btn" type="button" disabled={busy} onclick={onrerun}>Re-run model</button>
{/snippet}

<div class="review">
  {#if step === 'title'}
    <div class="intro">
      <h1>Does this title work?</h1>
      <p class="help">
        Plain, in your channel's format, under {TITLE_MAX} characters. Edit it or keep it.
      </p>
    </div>
    <div class="field" class:err={errors.title}>
      <label for="title">Title <span>{title.length} / {TITLE_MAX}</span></label>
      <input
        id="title"
        class="title-input"
        bind:value={title}
        maxlength={TITLE_MAX}
        autocomplete="off"
      />
      {#if errors.title}<span class="msg">{errors.title}</span>{/if}
    </div>
    {@render why(pick.why.title, 'title')}
    <div class="actions">
      {@render rerun()}
      <button class="btn primary" type="button" disabled={busy || !!errors.title} onclick={next}
        >Keep it, next</button
      >
    </div>
  {:else if step === 'description'}
    <div class="intro">
      <h1>Read the description</h1>
      <p class="help">
        It ends with hashtags picked from a real search, never invented. Fix anything that isn't
        true.
      </p>
    </div>
    <div class="field" class:err={errors.description}>
      <label for="desc">Description <span>{description.length} / {DESCRIPTION_MAX}</span></label>
      <textarea id="desc" rows="10" bind:value={description}></textarea>
      {#if errors.description}<span class="msg">{errors.description}</span>{/if}
    </div>
    {@render why(pick.why.description, 'description')}
    <div class="actions">
      <button class="btn" type="button" onclick={back}>Back</button>
      {@render rerun()}
      <button
        class="btn primary"
        type="button"
        disabled={busy || !!errors.description}
        onclick={next}>Looks right, next</button
      >
    </div>
  {:else if step === 'tags'}
    <div class="intro">
      <h1>Check the tags</h1>
      <p class="help">Plain terms, comma-separated. Hashtags live in the description.</p>
    </div>
    <div class="field" class:err={errors.tags}>
      <label for="tags">Tags <span>{tagCount} / {TAGS_MAX}</span></label>
      {#if artistName}
        <p class="fixed-tag"><span class="chip">{artistName}</span> Artist tag, always included</p>
      {/if}
      <textarea id="tags" rows="4" bind:value={tagsText}></textarea>
      {#if errors.tags}<span class="msg">{errors.tags}</span>{/if}
    </div>
    {@render why(pick.why.tags, 'tags')}
    <div class="actions">
      <button class="btn" type="button" onclick={back}>Back</button>
      {@render rerun()}
      <button class="btn primary" type="button" disabled={busy || !!errors.tags} onclick={next}
        >Fine, next</button
      >
    </div>
  {:else if step === 'check'}
    <div class="intro">
      <h1>
        {pick.flags.length === 1 ? 'One thing' : `${pick.flags.length} things`} to know before it uploads
      </h1>
      <p class="help">They matter wherever the song goes. You can still upload.</p>
    </div>
    <ul class="flags">
      {#each pick.flags as flag (flag)}
        <li class="notice" data-tone="warn">{flag}</li>
      {/each}
    </ul>
    <div class="actions">
      <button class="btn" type="button" onclick={back}>Back</button>
      <button class="btn primary" type="button" onclick={next}>Understood, next</button>
    </div>
  {:else}
    {@const hashtags = parseHashtags(description).length}
    <div class="intro">
      <h1>Ready to upload</h1>
      <p class="help">It goes up as Private. You publish it from YouTube whenever you want.</p>
    </div>
    <dl class="panel facts">
      <div>
        <dt>Title</dt>
        <dd>{title}</dd>
      </div>
      <div>
        <dt>Description</dt>
        <dd>
          {description.length} characters · {hashtags}
          {hashtags === 1 ? 'hashtag' : 'hashtags'}
        </dd>
      </div>
      <div>
        <dt>Tags</dt>
        <dd>{tags.length} tags · {tagCount} characters</dd>
      </div>
      <div>
        <dt>Channel</dt>
        <dd>
          {#if destination}
            {destination.channelTitle ?? 'your channel'}
            <span class="help">{destination.channelId}</span>
          {:else}
            Not connected
          {/if}
        </dd>
      </div>
      <div>
        <dt>Visibility</dt>
        <dd>Private</dd>
      </div>
      {#if hasFlags}<div>
          <dt>Flags</dt>
          <dd>{pick.flags.length} noted</dd>
        </div>{/if}
    </dl>
    {@render summary?.()}
    {#if firstError}
      <div class="notice" data-tone="err" role="alert">
        <strong>{errors[firstError]}</strong>
        <button class="link" type="button" onclick={() => (step = firstError)}
          >Fix the {firstError}</button
        >
      </div>
    {/if}
    {#if !destination}
      <div class="notice" data-tone="warn">
        <strong>Reconnect YouTube to upload.</strong>
        <span class="help"
          >Everything you approved here is kept. Reconnecting the same channel picks up right here.</span
        >
        <a class="btn primary" href={resolve('connections')}>Reconnect YouTube</a>
      </div>
    {/if}
    <div class="actions">
      <button class="btn" type="button" onclick={back}>Back</button>
      <button class="btn danger small" type="button" disabled={busy} onclick={ondiscard}
        >Discard release</button
      >
      {#if destination}
        <button class="btn primary" type="button" disabled={busy || !!firstError} onclick={approve}
          >Approve &amp; upload</button
        >
      {/if}
    </div>
  {/if}
</div>

<style>
  .review {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .intro {
    display: grid;
    gap: 8px;
  }

  .intro .help {
    font-size: 16px;
  }

  .title-input {
    font-size: 20px;
    font-weight: 500;
  }

  .fixed-tag {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 13px;
    color: var(--muted);
  }

  .why {
    display: grid;
    gap: 4px;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: 12px;
  }

  .why h2 {
    font: 600 14px/1.4 var(--font-body);
  }

  .flags {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .facts {
    margin: 0;
    padding-block: 4px;
  }

  .facts div {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 0;
  }

  .facts div + div {
    border-top: 1px solid var(--line);
  }

  dt {
    flex: none;
  }

  dd {
    display: grid;
    margin: 0;
    color: var(--muted);
    text-align: right;
    overflow-wrap: anywhere;
  }

  .notice .btn {
    justify-self: start;
    margin-top: 8px;
  }

  .link {
    justify-self: start;
    padding: 0;
    min-height: 44px;
    border: 0;
    background: none;
    color: var(--action);
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  /* Secondary actions left, the one primary right. */
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  .actions .primary {
    margin-left: auto;
  }

  /* Phones: pinned to the bottom of the screen, primary full width on top. */
  @media (width < 560px) {
    .actions {
      position: sticky;
      bottom: 0;
      margin-inline: calc(-1 * var(--gutter));
      padding: 12px var(--gutter) 20px;
      border-top: 1px solid var(--line);
      background: var(--ground);
    }

    .actions .btn {
      flex: 1;
    }

    .actions .primary {
      flex-basis: 100%;
      order: -1;
      margin-left: 0;
    }
  }
</style>

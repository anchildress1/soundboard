<script lang="ts">
  import { resolve } from '$app/paths';
  import type { Pick } from '#lib/types.js';

  let {
    bandcampUrl,
    jobId,
    songTitle,
    pick,
    tags,
    ondone,
  }: {
    /** The owner's `https://<name>.bandcamp.com`; null shows where to add it. */
    bandcampUrl: string | null;
    jobId: string;
    songTitle: string;
    pick: Pick;
    /** The tags going to YouTube: the approved ones once approved, so both destinations agree. */
    tags: string[];
    /** Called with whether every non-empty field has been copied. */
    ondone?: (done: boolean) => void;
  } = $props();

  const editor = $derived(bandcampUrl ? `${bandcampUrl}/edit_track` : null);

  const fields = $derived([
    { label: 'Track name', value: songTitle },
    { label: 'About', value: pick.bandcamp.about },
    { label: 'Credits', value: pick.bandcamp.credits },
    { label: 'Tags', value: tags.join(', ') },
  ]);

  // Copies are remembered per pick in this browser, so a reload keeps the checklist. The copied
  // text is kept, not just the label: an approved edit changes the value and needs a new copy.
  const storageKey = $derived(`bandcamp:${jobId}:${pick.version}`);
  let copied = $state<Record<string, string>>({});
  let last = $state('');
  const isCopied = (label: string, value: string) => copied[label] === value;

  $effect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
      copied =
        stored && typeof stored === 'object' && !Array.isArray(stored)
          ? (stored as Record<string, string>)
          : {};
    } catch {
      copied = {};
    }
  });

  $effect(() => {
    ondone?.(fields.every((f) => !f.value || isCopied(f.label, f.value)));
  });

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    last = label;
    copied = { ...copied, [label]: value };
    try {
      localStorage.setItem(storageKey, JSON.stringify(copied));
    } catch {
      // Private mode or blocked storage: the checklist just won't survive a reload.
    }
  };

  /**
   * A separate window keeps Bandcamp beside Soundboard; a blocked popup falls back to a tab. The
   * window opens blank and drops its opener before it loads Bandcamp, so the page can't reach back.
   */
  const openEditor = (event: MouseEvent) => {
    if (!editor) return;
    const opened = window.open('', 'bandcamp', 'popup,width=1200,height=900');
    if (!opened) return;
    opened.opener = null;
    opened.location.href = editor;
    event.preventDefault();
  };
</script>

<section class="bandcamp" aria-labelledby="bandcamp-title">
  <div class="head">
    <h2 id="bandcamp-title">Bandcamp</h2>
    {#if editor}
      <!-- Bandcamp has no artist upload API and refuses to be framed, so the editor opens outside. -->
      <a
        class="btn primary"
        href={editor}
        target="_blank"
        rel="noopener noreferrer"
        onclick={openEditor}>Open Bandcamp's new-track page</a
      >
    {:else}
      <a href={resolve('settings')}>Add your Bandcamp URL in Settings</a>
    {/if}
  </div>
  <p class="hint">Copy each field into the track editor. Every field copied marks Bandcamp done.</p>
  <dl>
    {#each fields as field (field.label)}
      {@const done = isCopied(field.label, field.value)}
      <div class="field" class:copied={done}>
        <dt>
          <span class="dot" data-tone={done ? 'ok' : 'idle'}></span>{field.label}
        </dt>
        <dd>{field.value}</dd>
        <button
          class="btn small"
          type="button"
          disabled={!field.value}
          aria-label="Copy {field.label}"
          onclick={() => copy(field.label, field.value)}>{done ? 'Copied' : 'Copy'}</button
        >
      </div>
    {/each}
  </dl>
  <p class="visually-hidden" aria-live="polite">{last ? `${last} copied` : ''}</p>
</section>

<style>
  .bandcamp {
    display: grid;
    gap: 16px;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  h2 {
    font: 600 16px/1.4 var(--font-body);
  }

  dl {
    display: grid;
    gap: 10px;
    margin: 0;
  }

  .field {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px 12px;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
  }

  dt {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--muted);
  }

  dd {
    grid-column: 1;
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .field .btn {
    grid-column: 2;
    grid-row: 1 / span 2;
  }
</style>

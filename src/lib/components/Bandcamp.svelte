<script lang="ts">
  import type { Pick } from '$lib/types';

  const EDITOR = 'https://flieslikerobots.bandcamp.com/edit_track';

  let {
    jobId,
    songTitle,
    pick,
    tags,
    ondone,
  }: {
    jobId: string;
    songTitle: string;
    pick: Pick;
    /** The tags going to YouTube: the approved ones once approved, so both destinations agree. */
    tags: string[];
    /** Called with whether every non-empty field has been copied. */
    ondone?: (done: boolean) => void;
  } = $props();

  const fields = $derived([
    { label: 'Track name', value: songTitle },
    { label: 'About', value: pick.bandcamp.about },
    { label: 'Credits', value: pick.bandcamp.credits },
    { label: 'Tags', value: tags.join(', ') },
  ]);

  // Copies are remembered per pick in this browser, so a reload keeps the checklist.
  const storageKey = $derived(`bandcamp:${jobId}:${pick.version}`);
  let copied = $state<string[]>([]);
  let last = $state('');

  $effect(() => {
    try {
      copied = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[];
    } catch {
      copied = [];
    }
  });

  $effect(() => {
    ondone?.(fields.every((f) => !f.value || copied.includes(f.label)));
  });

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    last = label;
    if (!copied.includes(label)) copied = [...copied, label];
    try {
      localStorage.setItem(storageKey, JSON.stringify(copied));
    } catch {
      // Private mode or blocked storage: the checklist just won't survive a reload.
    }
  }

  /** A separate window keeps Bandcamp beside Soundboard; a blocked popup falls back to a tab. */
  function openEditor(event: MouseEvent) {
    const opened = window.open(EDITOR, 'bandcamp', 'popup,width=1200,height=900');
    if (opened) event.preventDefault();
  }
</script>

<section class="bandcamp" aria-labelledby="bandcamp-title">
  <div class="head">
    <h2 id="bandcamp-title">Bandcamp</h2>
    <!-- Bandcamp has no artist upload API and refuses to be framed, so the editor opens outside. -->
    <a
      class="btn ghost small"
      href={EDITOR}
      target="_blank"
      rel="noopener noreferrer"
      onclick={openEditor}>Open Bandcamp's new-track page</a
    >
  </div>
  <p class="hint">Copy each field into the track editor. Every field copied marks Bandcamp done.</p>
  <dl>
    {#each fields as field (field.label)}
      {@const isCopied = copied.includes(field.label)}
      <div class="field" class:copied={isCopied}>
        <dt>
          <span class="mark" aria-hidden="true">{isCopied ? '✓' : '●'}</span>{field.label}
        </dt>
        <dd>{field.value}</dd>
        <button
          class="btn ghost small"
          type="button"
          disabled={!field.value}
          aria-label="Copy {field.label}"
          onclick={() => copy(field.label, field.value)}>{isCopied ? 'Copied' : 'Copy'}</button
        >
      </div>
    {/each}
  </dl>
  <p class="visually-hidden" aria-live="polite">{last ? `${last} copied` : ''}</p>
</section>

<style>
  .bandcamp {
    background: var(--panel);
    padding: 12px 14px;
    display: grid;
    gap: 10px;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  h2 {
    margin: 0;
    font: 900 12px/1.2 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--orange);
  }

  .head a {
    text-decoration: none;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  dl {
    margin: 0;
    display: grid;
    gap: 10px;
  }

  .field {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 12px;
    align-items: start;
  }

  dt {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 6px;
    font: 600 12px/1 var(--sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .mark {
    font-size: 10px;
    color: var(--yellow);
  }

  .copied .mark {
    color: var(--green);
  }

  dd {
    margin: 0;
    padding: 8px 10px;
    background: var(--well);
    border-left: 3px solid var(--yellow);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 14px;
  }

  .copied dd {
    border-left-color: var(--green);
  }
</style>

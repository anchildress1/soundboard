<script lang="ts">
  import type { Pick } from '$lib/types';

  let { songTitle, pick }: { songTitle: string; pick: Pick } = $props();

  const fields = $derived([
    { label: 'Track name', value: songTitle },
    { label: 'About', value: pick.bandcamp.about },
    { label: 'Credits', value: pick.bandcamp.credits },
    { label: 'Tags', value: pick.tags.join(', ') },
  ]);

  let copied = $state('');

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      copied = label;
    } catch {
      copied = '';
    }
  }
</script>

<section class="bandcamp" aria-labelledby="bandcamp-title">
  <div class="head">
    <h2 id="bandcamp-title">Bandcamp</h2>
    <!-- Bandcamp has no artist upload API and refuses to be framed, so the editor opens in a tab. -->
    <a
      class="btn ghost small"
      href="https://flieslikerobots.bandcamp.com/edit_track"
      target="_blank"
      rel="noopener noreferrer">Open Bandcamp's new-track page</a
    >
  </div>
  <p class="hint">Copy each field into the track editor.</p>
  <dl>
    {#each fields as field (field.label)}
      <div class="field">
        <dt>{field.label}</dt>
        <dd>{field.value}</dd>
        <button
          class="btn ghost small"
          type="button"
          disabled={!field.value}
          aria-label="Copy {field.label}"
          onclick={() => copy(field.label, field.value)}
          >{copied === field.label ? 'Copied' : 'Copy'}</button
        >
      </div>
    {/each}
  </dl>
  <p class="visually-hidden" aria-live="polite">{copied ? `${copied} copied` : ''}</p>
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
    font: 600 12px/1 var(--sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  dd {
    margin: 0;
    padding: 8px 10px;
    background: var(--well);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 14px;
  }
</style>

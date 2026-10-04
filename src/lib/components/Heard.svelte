<script lang="ts">
  import type { Measurements } from '$lib/types';

  let { tags, measurements }: { tags: string[]; measurements: Measurements | null } = $props();

  const fmt = (n: number | null, unit: string) => (n === null ? null : `${n.toFixed(1)} ${unit}`);
  const measured = $derived(
    measurements
      ? [
          fmt(measurements.integratedLufs, 'LUFS'),
          fmt(measurements.truePeakDbtp, 'dBTP'),
          `${measurements.clippedSamples} clipped`,
          `${measurements.silences.length} silences`,
        ].filter(Boolean)
      : [],
  );
</script>

<div class="heard">
  <h2>What the model heard</h2>
  {#if tags.length > 0}
    <ul>
      {#each tags as tag (tag)}<li>{tag}</li>{/each}
    </ul>
  {:else}
    <p>Tags appear as each chunk is analyzed.</p>
  {/if}
  {#if measured.length > 0}
    <p class="ffmpeg"><span>ffmpeg</span> {measured.join(' · ')}</p>
  {/if}
</div>

<style>
  .heard {
    border-left: 3px solid var(--orange);
    padding: 10px 14px;
    background: var(--panel);
    min-width: 0;
  }

  h2 {
    margin: 0 0 6px;
    font: 900 12px/1 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--orange);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    font: 500 12px/1.2 var(--mono);
    color: var(--ink);
  }

  li {
    padding: 5px 8px;
    background: var(--well);
    animation: pop 0.3s ease-out both;
  }

  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.9);
    }
  }

  p {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .ffmpeg {
    font: 500 12px/1.4 var(--mono);
    color: var(--ink);
  }

  .ffmpeg span {
    color: var(--muted);
  }
</style>

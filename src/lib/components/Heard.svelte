<script lang="ts">
  import type { Measurements } from '#lib/types.js';

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

<div class="heard panel">
  <h2>What the model heard</h2>
  {#if tags.length > 0}
    <ul>
      {#each tags as tag (tag)}<li class="chip">{tag}</li>{/each}
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
    display: grid;
    gap: 10px;
    min-width: 0;
  }

  h2 {
    font: 600 16px/1.4 var(--font-body);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  p {
    font-size: 14px;
    color: var(--muted);
  }

  .ffmpeg {
    font-variant-numeric: tabular-nums;
  }

  .ffmpeg span {
    font-weight: 600;
  }
</style>

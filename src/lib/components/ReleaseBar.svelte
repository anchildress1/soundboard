<script lang="ts">
  import { resolve } from '$app/paths';
  import { STEPS, stepLabel } from '$lib/release';

  let {
    title,
    step,
    label = stepLabel(step),
  }: {
    /** The song, shown on the way back home. */
    title: string;
    /** Index into STEPS of the step on screen; past the end once done. */
    step: number;
    /** Overrides the step name, for side trips like the Short. */
    label?: string;
  } = $props();
</script>

<div class="release-bar">
  <div class="row">
    <a class="back" href={resolve('/')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      <span><span class="visually-hidden">Back to releases from</span> {title}</span>
    </a>
    <span class="label">{label}</span>
    <!-- Before Listening there is nothing saved yet, and leaving mid-upload loses the file. -->
    {#if step > 0 && step < STEPS.length}
      <a class="btn small" href={resolve('/')}>Save &amp; leave</a>
    {/if}
  </div>
  <!-- The Signal Line: the only map. Done steps are lit, the current one carries the signal. -->
  <ol class="rail" aria-hidden="true">
    {#each STEPS as name, i (name)}
      <li class:done={i < step} class:current={i === step}></li>
    {/each}
  </ol>
</div>

<style>
  .release-bar {
    display: grid;
    gap: 12px;
    width: 100%;
    max-width: calc(var(--measure-step) + 2 * var(--gutter));
    margin: 0 auto;
    padding: 12px var(--gutter) 0;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 12px;
  }

  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    min-height: 44px;
    color: var(--ink);
    font-weight: 600;
    text-decoration: none;
  }

  .back > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .back svg {
    flex: none;
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .label {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    white-space: nowrap;
  }

  /* Phones: the step name drops under the back link so the song title keeps the width. */
  @media (width < 560px) {
    .row {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .label {
      grid-row: 2;
    }
  }

  .rail {
    display: flex;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .rail li {
    flex: 1;
    height: 3px;
    border-radius: 2px;
    background: var(--well);
  }

  .rail .done {
    background: var(--action);
  }

  .rail .current {
    background: var(--signal);
  }
</style>

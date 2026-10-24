<script lang="ts">
  import type { Status } from '$lib/status';

  let {
    status,
    model,
    seconds = null,
  }: { status: Status; model: string; seconds?: number | null } = $props();
</script>

<div class="track">
  <span class="state" data-tone={status.tone} role="status" aria-live="polite">{status.text}</span>
  <div
    class="bar"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={status.progress}
  >
    <i style:--p="{status.progress}%"></i>
  </div>
  <span class="model">
    <span>{model}</span>
    {#if seconds}<span>Total model time: {seconds}s</span>{/if}
  </span>
</div>

<style>
  .track {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 12px;
    align-items: center;
    font: 500 12px/1 var(--mono);
    color: var(--muted);
  }

  .model {
    display: grid;
    gap: 4px;
    justify-items: end;
  }

  /* The configured model name is too long to share a phone row with the chip and bar. */
  @media (width < 640px) {
    .track {
      grid-template-columns: auto 1fr;
    }

    .model {
      grid-column: 1 / -1;
      justify-items: start;
    }
  }

  .bar {
    height: 6px;
    background: var(--well);
    position: relative;
    overflow: hidden;
  }

  .bar i {
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--p, 0%);
    background: var(--magenta);
  }

  @media (prefers-reduced-motion: no-preference) {
    .bar i {
      transition: width 0.5s;
    }
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    font: 600 12px/1 var(--sans);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid currentColor;
  }

  .state::before {
    content: '';
    width: 8px;
    height: 8px;
    background: currentColor;
  }

  .state[data-tone='info'] {
    color: var(--info);
  }

  .state[data-tone='warn'] {
    color: var(--yellow);
  }

  .state[data-tone='ok'] {
    color: var(--green);
  }

  .state[data-tone='err'] {
    color: var(--red-text);
  }
</style>

<script lang="ts">
  import type { Status } from '$lib/status';

  let { status, model }: { status: Status; model: string } = $props();
</script>

<div class="track">
  <div class="row">
    <span class="state" data-tone={status.tone} role="status" aria-live="polite">{status.text}</span
    >
    <span class="model">{model}</span>
  </div>
  <div
    class="bar"
    role="progressbar"
    aria-label="Progress"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={status.progress}
  >
    <i style:--p="{status.progress}%"></i>
  </div>
</div>

<style>
  .track {
    display: grid;
    gap: 10px;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 4px 16px;
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }

  .state::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tone);
  }

  .state[data-tone='info'] {
    --tone: var(--running);
  }

  .state[data-tone='warn'] {
    --tone: var(--attention);
  }

  .state[data-tone='ok'] {
    --tone: var(--ok);
  }

  .state[data-tone='err'] {
    --tone: var(--err);
  }

  .model {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }

  /* The Signal Line. */
  .bar {
    height: 3px;
    border-radius: 2px;
    background: var(--well);
    overflow: hidden;
  }

  .bar i {
    display: block;
    width: var(--p, 0%);
    height: 100%;
    border-radius: 2px;
    background: var(--signal);
    transition: width var(--motion-slow);
  }
</style>

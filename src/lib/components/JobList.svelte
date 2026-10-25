<script lang="ts">
  import { resolve } from '$app/paths';
  import type { JobState } from '#lib/types.js';

  type Job = { id: string; songTitle: string; state: JobState };

  let { jobs }: { jobs: Job[] } = $props();

  const LABELS: Record<JobState, string> = {
    AWAITING_UPLOAD: 'Uploading',
    PREP: 'Measuring audio',
    ANALYZE: 'Analyzing',
    PICK: 'Smart pick',
    HOOK: 'Picking the hook',
    RENDER: 'Cutting the Short',
    REVIEW: 'Needs review',
    PUBLISHING: 'Uploading to YouTube',
    CLAIMED_COMPLETE: 'Verifying upload',
    VERIFIED: 'Verified · private',
    FAILED: 'Failed',
    DISCARDED: 'Discarded',
  };
</script>

{#if jobs.length > 0}
  <section class="runs" aria-labelledby="runs-heading">
    <h2 id="runs-heading">Your runs</h2>
    <ul>
      {#each jobs as job (job.id)}
        <li>
          <span class="title">{job.songTitle}</span>
          <span class="state">{LABELS[job.state]}</span>
          <a
            class="btn ghost small"
            href={resolve('/jobs/[id]', { id: job.id })}
            aria-label="Continue {job.songTitle}">Continue</a
          >
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .runs {
    display: grid;
    gap: 10px;
    min-width: 0;
  }

  h2 {
    margin: 0;
    font: 900 13px/1 var(--display);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    padding: 10px 0;
    border-top: 1px solid var(--well);
  }

  .title {
    flex: 1 1 12ch;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .state {
    font: 500 12px/1.4 var(--mono);
    color: var(--muted);
  }

  .btn {
    text-decoration: none;
  }
</style>

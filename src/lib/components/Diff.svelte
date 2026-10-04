<script lang="ts">
  import type { LiveMetadata, Pick } from '$lib/types';

  let { live, pick }: { live: LiveMetadata; pick: Pick } = $props();

  const rows = $derived([
    { field: 'Title', current: live.title, proposed: pick.title, why: pick.why.title },
    {
      field: 'Description',
      current: live.description,
      proposed: pick.description,
      why: pick.why.description,
    },
    {
      field: 'Tags',
      current: live.tags.join(', '),
      proposed: pick.tags.join(', '),
      why: pick.why.tags,
    },
  ]);
</script>

<section class="diff" aria-label="Current versus proposed">
  <h2>
    Live video vs proposal
    <a href="https://youtu.be/{live.videoId}" target="_blank" rel="noopener"
      >youtu.be/{live.videoId}</a
    >
  </h2>
  {#each rows as row (row.field)}
    <div class="row">
      <h3>{row.field}</h3>
      <div class="pair">
        <div>
          <span class="tag">Current</span>
          <p>{row.current || '(empty)'}</p>
        </div>
        <div>
          <span class="tag proposed">Proposed</span>
          <p>{row.proposed}</p>
        </div>
      </div>
      <p class="why"><span>Why</span> {row.why}</p>
    </div>
  {/each}
</section>

<style>
  .diff {
    background: var(--panel);
    border-left: 3px solid var(--blue);
    padding: 12px 14px;
    display: grid;
    gap: 14px;
    min-width: 0;
  }

  h2 {
    margin: 0;
    font: 900 12px/1.4 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--info);
    display: flex;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }

  h2 a {
    font: 500 11px/1.4 var(--mono);
    letter-spacing: 0;
    text-transform: none;
  }

  h3 {
    margin: 0 0 6px;
    font: 600 12px/1 var(--sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  @media (max-width: 480px) {
    .pair {
      grid-template-columns: 1fr;
    }
  }

  .pair p {
    margin: 4px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 13px;
    max-height: 12em;
    overflow: auto;
  }

  .tag {
    font: 500 11px/1 var(--mono);
    color: var(--muted);
  }

  .tag.proposed {
    color: var(--magenta);
  }

  .why {
    margin: 6px 0 0;
    font-size: 13px;
    color: var(--ink);
  }

  .why span {
    font: 500 11px/1 var(--mono);
    color: var(--orange);
  }
</style>

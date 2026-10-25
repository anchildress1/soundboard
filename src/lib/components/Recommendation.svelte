<script lang="ts">
  import { ROLES } from '#lib/influence.js';
  import {
    citationText,
    countLabel,
    limitText,
    netLabel,
    rangeLabel,
    type ReviewData,
  } from '#lib/review.js';

  let { data }: { data: ReviewData } = $props();

  const FOLLOWS = {
    artist: 'Your own results and writing',
    peers: 'Similar artists',
    both: 'Your own results and similar artists',
    none: 'Neither: there was too little evidence',
  } as const;
  const COVERAGE = {
    open: 'still collecting',
    unknown: 'may be incomplete',
    complete: '',
  } as const;
  const ROLE_LABELS = {
    sound: 'Sound',
    feel: 'Feel',
    wording: 'Wording',
    discovery: 'Discovery',
    structure: 'Structure',
  } as const;

  const recommendation = $derived(data.recommendation);
</script>

<section class="recommendation panel" aria-labelledby="recommendation-heading">
  <h2 id="recommendation-heading">Recommendation</h2>

  {#if recommendation}
    <dl class="facts">
      <div>
        <dt>Try</dt>
        <dd>{recommendation.approach}</dd>
      </div>
      <div>
        <dt>Aim</dt>
        <dd>{recommendation.intendedOutcome}</dd>
      </div>
      <div>
        <dt>Follows</dt>
        <dd>
          {FOLLOWS[recommendation.follows]}
          {#if recommendation.followsWhy}<span class="help">{recommendation.followsWhy}</span>{/if}
        </dd>
      </div>
      {#if data.evidence.length > 0}
        <div>
          <dt>Based on</dt>
          <dd>
            <ul>
              {#each data.evidence as citation (citation.ref)}
                <li>{citationText(citation)}</li>
              {/each}
            </ul>
          </dd>
        </div>
      {/if}
    </dl>
  {:else}
    <p class="help">No recommendation for this draft.</p>
  {/if}

  {#if data.limits.length > 0}
    <ul class="limits">
      {#each data.limits as limit (limit)}
        <li class="help">{limitText(limit)}</li>
      {/each}
    </ul>
  {/if}

  {#if data.influenceWarning}
    <p class="notice" data-tone="warn" role="note">{data.influenceWarning}</p>
  {/if}

  {#if data.ranges}
    <p class="help">
      Your range: {rangeLabel(data.ranges.current)} subscribers.
      {#if data.ranges.target !== null}
        Next range: {rangeLabel(data.ranges.target)}.
      {/if}
    </p>
  {/if}

  {#if data.influence}
    <details>
      <summary>Peer influence used</summary>
      <dl class="levels">
        {#each ROLES as role (role)}
          <div>
            <dt>{ROLE_LABELS[role]}</dt>
            <dd>{data.influence[role]} of 4</dd>
          </div>
        {/each}
      </dl>
    </details>
  {/if}

  {#if data.results.length > 0}
    <section class="results" aria-labelledby="results-heading">
      <h3 id="results-heading">Your results (YouTube Analytics)</h3>
      <ul>
        {#each data.results as result (result.ref)}
          <li>
            <strong>{result.title}</strong>
            <span class="help">
              {result.requested.start} to {result.requested.end}
              {#if COVERAGE[result.coverage]}· {COVERAGE[result.coverage]}{/if}
            </span>
            <dl class="levels">
              <div>
                <dt>Views</dt>
                <dd>{countLabel(result.metrics.views)}</dd>
              </div>
              <div>
                <dt>Subscribers gained</dt>
                <dd>
                  {countLabel(result.metrics.subscribersGained)}
                  <span class="help">on this video's page; a lower bound</span>
                </dd>
              </div>
              <div>
                <dt>Subscribers lost</dt>
                <dd>{countLabel(result.metrics.subscribersLost)}</dd>
              </div>
              <div>
                <dt>Net subscribers</dt>
                <dd>{netLabel(result.net)} <span class="help">calculated</span></dd>
              </div>
            </dl>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</section>

<style>
  .recommendation {
    display: grid;
    gap: 14px;
    padding: 16px;
  }

  h2 {
    font: 600 16px/1.4 var(--font-body);
  }

  h3 {
    font: 600 14px/1.4 var(--font-body);
  }

  .facts,
  .levels {
    display: grid;
    gap: 10px;
    margin: 0;
  }

  .facts > div,
  .levels > div {
    display: grid;
    gap: 2px;
  }

  dt {
    font-size: 13px;
    color: var(--muted);
  }

  dd {
    display: grid;
    gap: 2px;
    margin: 0;
    overflow-wrap: anywhere;
  }

  ul {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .results ul {
    gap: 14px;
  }

  .results li {
    display: grid;
    gap: 6px;
  }

  summary {
    cursor: pointer;
    min-height: 44px;
    display: flex;
    align-items: center;
  }

  @media (width >= 640px) {
    .levels {
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    }
  }
</style>

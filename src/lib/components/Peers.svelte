<script lang="ts">
  import {
    countLabel,
    dateLabel,
    rateLabel,
    type ReviewPeer,
    type ReviewRelease,
  } from '#lib/review.js';

  let {
    peers,
    expiresAt,
    busy = false,
    onreject,
  }: {
    /** Null once the pick's evidence is hidden or deleted. */
    peers: ReviewPeer[] | null;
    expiresAt: string | null;
    busy?: boolean;
    onreject: (ref: string) => void;
  } = $props();

  const BASIS = { heard: 'Heard', 'metadata-only': 'Metadata only' } as const;
  const SELECTED: Record<ReviewRelease['selectedAs'], string> = {
    newest: 'Newest',
    'most-viewed': 'Most viewed',
    'most-engaged': 'Most engaged',
  };
</script>

<section class="peers" aria-labelledby="peers-heading">
  {#if peers === null}
    <h2 id="peers-heading">Similar artists</h2>
    <p class="help">
      {expiresAt ? `Peer evidence expired on ${dateLabel(expiresAt)}` : 'Peer evidence expired'}
    </p>
  {:else}
    <details>
      <summary id="peers-heading">Similar artists ({peers.length})</summary>
      {#if peers.length === 0}
        <p class="help">No similar artists were used for this draft.</p>
      {/if}
      <ul class="list">
        {#each peers as peer (peer.ref)}
          <li class="panel peer">
            <div class="head">
              <h3>{peer.title}</h3>
              <span class="chip">{BASIS[peer.basis]}</span>
              {#if peer.secondary}<span class="chip">Secondary</span>{/if}
            </div>
            <p class="help">{peer.explanation}</p>
            <dl class="stats" aria-label="Public reach on YouTube">
              <div>
                <dt>Public reach on YouTube</dt>
                <dd>
                  {countLabel(peer.stats.subscribers)} subscribers · {countLabel(peer.stats.videos)}
                  videos · {countLabel(peer.stats.views)} views
                </dd>
              </div>
              <div>
                <dt>Retrieved</dt>
                <dd>{dateLabel(peer.retrievedAt)}</dd>
              </div>
            </dl>
            {#if peer.releases.length > 0}
              <ul class="releases">
                {#each peer.releases as release (release.ref)}
                  <li>
                    <a href={release.url} target="_blank" rel="external noopener noreferrer"
                      >{release.title}</a
                    >
                    <span class="help">
                      {SELECTED[release.selectedAs]} · {countLabel(release.stats.views)} views ·
                      {countLabel(release.stats.likes)} likes ·
                      {countLabel(release.stats.comments)} comments · engagement
                      {rateLabel(release.engagement)} (calculated) ·
                      {dateLabel(release.publishedAt)}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
            <button
              class="btn small"
              type="button"
              disabled={busy}
              onclick={() => onreject(peer.ref)}>Not a peer</button
            >
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</section>

<style>
  .peers {
    display: grid;
    gap: 8px;
  }

  h2 {
    font: 600 16px/1.4 var(--font-body);
  }

  h3 {
    font: 600 15px/1.4 var(--font-body);
    overflow-wrap: anywhere;
  }

  summary {
    cursor: pointer;
    min-height: 44px;
    display: flex;
    align-items: center;
    font: 600 16px/1.4 var(--font-body);
  }

  .list,
  .releases {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .peer {
    display: grid;
    gap: 10px;
    padding: 14px 16px;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .stats {
    display: grid;
    gap: 6px;
    margin: 0;
  }

  .stats dt {
    font-size: 13px;
    color: var(--muted);
  }

  .stats dd {
    margin: 0;
  }

  .releases {
    gap: 8px;
    font-size: 14px;
  }

  .releases li {
    display: grid;
    gap: 2px;
    overflow-wrap: anywhere;
  }

  .peer .btn {
    justify-self: start;
  }
</style>

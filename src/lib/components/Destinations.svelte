<script lang="ts">
  import type { Snippet } from 'svelte';

  type Tab = { id: 'youtube' | 'short' | 'bandcamp'; label: string; done: boolean; panel: Snippet };

  let {
    youtube,
    short,
    bandcamp,
    youtubeDone,
    shortDone,
    bandcampDone,
  }: {
    youtube: Snippet;
    short: Snippet;
    bandcamp: Snippet;
    youtubeDone: boolean;
    shortDone: boolean;
    bandcampDone: boolean;
  } = $props();

  const tabs = $derived<Tab[]>([
    { id: 'youtube', label: 'YouTube', done: youtubeDone, panel: youtube },
    { id: 'short', label: 'Short', done: shortDone, panel: short },
    { id: 'bandcamp', label: 'Bandcamp', done: bandcampDone, panel: bandcamp },
  ]);

  let active = $state<Tab['id']>('youtube');
  const buttons: Record<string, HTMLButtonElement> = {};

  /** Arrow keys, Home, and End move between tabs, per the WAI-ARIA tabs pattern. */
  function onkeydown(event: KeyboardEvent) {
    const index = tabs.findIndex((t) => t.id === active);
    const to: Record<string, number> = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    };
    if (to[event.key] === undefined) return;
    event.preventDefault();
    const next = tabs[to[event.key]!]!;
    active = next.id;
    buttons[next.id]?.focus();
  }
</script>

<div class="destinations">
  <div class="tablist" role="tablist" aria-label="Where it goes">
    {#each tabs as tab (tab.id)}
      <button
        bind:this={buttons[tab.id]}
        id="tab-{tab.id}"
        type="button"
        role="tab"
        class:done={tab.done}
        aria-selected={active === tab.id}
        aria-controls="panel-{tab.id}"
        tabindex={active === tab.id ? 0 : -1}
        onclick={() => (active = tab.id)}
        {onkeydown}
      >
        <span class="mark" aria-hidden="true">{tab.done ? '✓' : '●'}</span>
        {tab.label}
        <span class="state">{tab.done ? 'Done' : 'To do'}</span>
      </button>
    {/each}
  </div>
  {#each tabs as tab (tab.id)}
    <div
      id="panel-{tab.id}"
      role="tabpanel"
      aria-labelledby="tab-{tab.id}"
      hidden={active !== tab.id}
      tabindex="0"
    >
      {@render tab.panel()}
    </div>
  {/each}
</div>

<style>
  .destinations {
    display: grid;
    gap: 14px;
    min-width: 0;
  }

  .tablist {
    display: flex;
    gap: 6px;
    border-bottom: 1px solid var(--well);
  }

  [role='tab'] {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 4px 8px;
    min-width: 0;
    min-height: 44px;
    padding: 6px 12px;
    white-space: nowrap;
    background: none;
    border: 0;
    border-bottom: 3px solid transparent;
    margin-bottom: -1px;
    color: var(--muted);
    font: 900 13px/1 var(--display);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
  }

  [role='tab'][aria-selected='true'] {
    color: var(--ink);
    border-bottom-color: var(--ink);
  }

  [role='tab']:focus-visible {
    outline: 2px solid var(--magenta);
    outline-offset: 2px;
  }

  .mark {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    font-size: 11px;
    color: var(--yellow);
  }

  .done .mark {
    border-radius: 50%;
    background: var(--green);
    color: var(--ground);
  }

  .state {
    white-space: nowrap;
    font: 500 11px/1 var(--mono);
    letter-spacing: 0;
    text-transform: none;
    color: var(--yellow);
  }

  .done .state {
    color: var(--green);
  }

  /* Three tabs don't fit a phone side by side with their state; it drops under the name. */
  @media (max-width: 520px) {
    [role='tab'] {
      flex: 1 1 0;
      padding: 6px 4px;
    }

    .state {
      flex-basis: 100%;
      text-align: center;
    }
  }

  [role='tabpanel'] {
    display: grid;
    gap: 14px;
    min-width: 0;
  }

  [role='tabpanel'][hidden] {
    display: none;
  }

  [role='tabpanel']:focus-visible {
    outline: 2px solid var(--magenta);
    outline-offset: 4px;
  }
</style>

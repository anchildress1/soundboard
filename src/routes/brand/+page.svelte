<script lang="ts">
  import { resolve } from '$app/paths';
  import BrandGuide from '#lib/components/BrandGuide.svelte';
  import VoiceGuide from '#lib/components/VoiceGuide.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Brand · Soundboard</title></svelte:head>

<main>
  <a class="back" href={resolve('/')}>Releases</a>
  <div class="intro">
    <h1>Brand</h1>
    <p class="help">
      Your voice shapes every description and hook. Your brand guide shapes every pick. Both start
      as proposals from your own uploads; nothing is used until you approve it.
    </p>
  </div>

  <div class="guides">
    <VoiceGuide guide={data.voice} />
    <BrandGuide guide={data.brand} />
  </div>
</main>

<style>
  main {
    width: 100%;
    max-width: var(--measure-page);
    margin: 0 auto;
    padding: 40px var(--gutter) 64px;
    display: flex;
    flex-direction: column;
    gap: 28px;
  }

  .back {
    align-self: flex-start;
    color: var(--muted);
    font-size: 14px;
  }

  .intro {
    display: grid;
    gap: 6px;
  }

  .intro p {
    max-width: 64ch;
    font-size: 16px;
  }

  .guides {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
    gap: 24px;
    align-items: start;
  }

  /* Both guide sections share one layout; the components carry only markup. */
  .guides :global(:is(.panel, .proposal)) {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }

  .guides :global(.panel) {
    padding: 24px;
  }

  .guides :global(.proposal) {
    padding-top: 16px;
    border-top: 2px solid var(--attention);
  }

  .guides :global(.head) {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }

  .guides :global(.statement) {
    font-size: 17px;
  }

  .guides :global(.rules) {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .guides :global(.rules li) {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 10px 0;
    border-top: 1px solid var(--line);
    font-size: 15px;
  }

  .guides :global(.rules .chip) {
    flex: none;
    min-width: 52px;
    justify-content: center;
  }

  .guides :global(.actions) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }

  .guides :global(.actions .primary) {
    margin-left: auto;
  }
</style>

<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import ArtistForm from '#lib/components/ArtistForm.svelte';
  import InfluenceSliders from '#lib/components/InfluenceSliders.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Settings · Soundboard</title></svelte:head>

<main>
  <a class="back" href={resolve('/')}>Releases</a>
  <h1>Settings</h1>

  <section class="panel" aria-labelledby="artist">
    <h2 id="artist">Artist</h2>
    <p class="help">New drafts use these. Drafts you already approved keep what you approved.</p>
    <ArtistForm
      initial={data.artist}
      submitLabel="Save changes"
      savedText="Saved."
      onsaved={() => invalidateAll()}
    />
  </section>

  <section class="panel" aria-labelledby="influence">
    <h2 id="influence">Peer influence</h2>
    <p class="help intro">
      How much each part of a draft leans on artists like you who reach more people, from your own
      history only to the strongest peer influence. New drafts use these; drafts you already made
      keep what they used.
    </p>
    <InfluenceSliders
      initial={data.influence}
      canSave={data.canSave}
      onsaved={() => invalidateAll()}
    />
  </section>

  <p class="help">
    Settings never override song facts, your identity and credits, the hashtag and tag candidate
    lists, or your approval.
  </p>
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
    max-width: 64ch;
  }

  .panel {
    display: grid;
    gap: 8px;
  }
</style>

<script lang="ts">
  import { resolve } from '$app/paths';

  // Spec 006, FR-021: what each role draws on before any slider moves.
  const ROLES = [
    { name: 'Sound', source: 'Song analysis; peer vocabulary may help describe it' },
    { name: 'Feel', source: "The artist's own writing and approved edits" },
    { name: 'Wording', source: "The artist's phrasing, sentence shape, and asides" },
    {
      name: 'Discovery',
      source:
        'Eligible peer tags, hashtags, and title keywords, limited to what the analysis heard',
    },
    {
      name: 'Structure',
      source: "Peer patterns for length and order; the artist's own identity and credit lines",
    },
  ];
</script>

<svelte:head><title>Peer influence · Soundboard</title></svelte:head>

<main>
  <a class="back" href={resolve('/')}>Releases</a>
  <div class="intro">
    <h1>Peer influence</h1>
    <p class="help">
      How much each part of a draft leans on artists like you who reach more people, from your own
      history only to the strongest peer influence. The sliders arrive with fanbase learning; until
      then every pick uses the defaults below.
    </p>
  </div>

  <section class="panel" aria-labelledby="defaults">
    <h2 id="defaults">Default sources</h2>
    <dl>
      {#each ROLES as role (role.name)}
        <div>
          <dt>{role.name}</dt>
          <dd class="help">{role.source}</dd>
        </div>
      {/each}
    </dl>
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
    display: grid;
    gap: 6px;
  }

  .intro p {
    max-width: 64ch;
    font-size: 16px;
  }

  .panel {
    display: grid;
    gap: 8px;
  }

  dl {
    margin: 0;
  }

  dl div {
    display: grid;
    grid-template-columns: minmax(0, 160px) minmax(0, 1fr);
    gap: 4px 20px;
    padding: 14px 0;
    border-top: 1px solid var(--line);
  }

  dt {
    font-weight: 600;
  }

  dd {
    margin: 0;
  }

  @media (width < 560px) {
    dl div {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>

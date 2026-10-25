<script lang="ts">
  import { resolve } from '$app/paths';

  /** The signed-in user's artist; null signed out, so a shared page names no one's artist. */
  let { artist }: { artist: { name: string; bandcampUrl: string | null } | null } = $props();
</script>

<footer>
  <p>
    {#if artist}
      Built for
      {#if artist.bandcampUrl}
        <a href={artist.bandcampUrl} target="_blank" rel="noopener noreferrer">{artist.name}</a>
      {:else}
        {artist.name}
      {/if}
      by Ashley Childress · PolyForm Noncommercial 1.0.0
    {:else}
      Built by Ashley Childress · PolyForm Noncommercial 1.0.0
    {/if}
  </p>
  <div class="links">
    <nav aria-label="Ashley Childress">
      <a href="https://anchildress1.dev" target="_blank" rel="noopener noreferrer">Site</a>
      <a href="https://github.com/anchildress1" target="_blank" rel="noopener noreferrer">GitHub</a>
      <a href="https://dev.to/anchildress1" target="_blank" rel="noopener noreferrer">DEV</a>
      <a href="https://www.linkedin.com/in/anchildress1" target="_blank" rel="noopener noreferrer"
        >LinkedIn</a
      >
      <a href="https://x.com/anchildress1" target="_blank" rel="noopener noreferrer">X</a>
    </nav>
    <nav aria-label="Legal">
      <a href={resolve('terms')} data-sveltekit-reload>Terms of Service</a>
      <a href={resolve('privacy')} data-sveltekit-reload>Privacy policy</a>
    </nav>
  </div>
</footer>

<style>
  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 24px;
    padding: 16px var(--gutter);
    border-top: 1px solid var(--line);
    font-size: 13px;
    color: var(--muted);
  }

  .links,
  nav {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 18px;
  }

  /* Phones stack the two groups, where a divider would dangle. */
  @media (width >= 640px) {
    .links nav + nav {
      padding-left: 18px;
      border-left: 1px solid var(--line-strong);
    }
  }

  a {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--muted);
    text-decoration: none;
  }

  a:hover {
    color: var(--ink);
    text-decoration: underline;
  }

  p a {
    min-height: 0;
    color: var(--ink);
  }
</style>

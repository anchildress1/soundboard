<script lang="ts">
  // Self-hosted fonts: a third-party font host made the first paint, and Lighthouse, swing.
  import '@fontsource-variable/bricolage-grotesque/opsz.css';
  import '@fontsource-variable/onest';
  import displayFont from '@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-opsz-normal.woff2?url';
  import '../app.css';
  import { resolve } from '$app/paths';
  import Footer from '$lib/components/Footer.svelte';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  let menu = $state<HTMLElement>();
  const artist = $derived(data.user?.artistId === 'flr');

  /** The popover outlives client-side navigation, so following one of its links closes it. */
  const closeOnLink = (event: MouseEvent) => {
    if ((event.target as Element).closest('a')) menu?.hidePopover();
  };
</script>

<svelte:head>
  <!-- Every page title is set in the display face; fetch it with the page instead of after the CSS. -->
  <link rel="preload" href={displayFont} as="font" type="font/woff2" crossorigin="anonymous" />
  <meta
    name="description"
    content="Release agent for Flies Like Robots: a self-hosted model watches and listens to a music video, then drafts and verifies the YouTube upload."
  />
</svelte:head>

<a class="skip" href="#content">Skip to content</a>

<div class="app">
  <header>
    <a class="wordmark" href={resolve('/')}><span aria-hidden="true"></span>Soundboard</a>
    {#if data.user}
      <div class="account">
        {#if data.channel?.handle}<span class="chip handle">{data.channel.handle}</span>{/if}
        <button class="btn small menu-button" type="button" popovertarget="menu" aria-label="Menu">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
      </div>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <nav id="menu" aria-label="Menu" popover bind:this={menu} onclick={closeOnLink}>
        <a href={resolve('/connections')}>Connections</a>
        {#if artist}
          <a href={resolve('/brand')}>Brand guide</a>
          <a href={resolve('/settings')}>Settings</a>
        {/if}
        <form method="POST" action="/auth/logout">
          <button type="submit" title={data.user.email}>Sign out</button>
        </form>
      </nav>
    {:else}
      <span class="help">Invite only</span>
    {/if}
  </header>

  <div id="content" class="content" tabindex="-1">
    {@render children()}
  </div>

  <Footer />
</div>

<style>
  .app {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }

  header {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 60px;
    padding: 8px var(--gutter);
    border-bottom: 1px solid var(--line);
  }

  .wordmark {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    color: var(--ink);
    font: 800 19px/1 var(--font-display);
    letter-spacing: -0.02em;
    text-decoration: none;
  }

  .wordmark span {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    background: var(--signal);
  }

  .account {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .handle {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu-button {
    width: 44px;
    padding: 0;
  }

  .menu-button svg {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }

  /* Top layer, pinned under the header's right edge. */
  #menu {
    position: fixed;
    inset: 64px var(--gutter) auto auto;
    width: 220px;
    margin: 0;
    padding: 6px 0;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    color: var(--ink);
  }

  #menu :is(a, button) {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 44px;
    padding: 0 16px;
    border: 0;
    background: none;
    color: var(--ink);
    font-weight: 500;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }

  #menu :is(a, button):hover {
    background: var(--well);
  }

  #menu form {
    margin: 0;
    border-top: 1px solid var(--line);
  }

  #menu button {
    color: var(--muted);
  }

  /* A real box, not display: contents, so the skip link can focus and scroll to it. */
  .content {
    flex: 1;
    display: block;
  }

  .content:focus {
    outline: none;
  }

  .skip {
    position: absolute;
    left: 16px;
    top: -60px;
    z-index: 10;
    padding: 12px 16px;
    border-radius: var(--radius-control);
    background: var(--action);
    color: var(--on-action);
    font-weight: 600;
    text-decoration: none;
    transition: top var(--motion);
  }

  .skip:focus {
    top: 8px;
  }
</style>

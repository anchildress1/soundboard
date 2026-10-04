<script lang="ts">
  // Self-hosted fonts: a third-party font host made the wordmark's paint, and Lighthouse, swing.
  import '@fontsource/inter/400.css';
  import '@fontsource/inter/600.css';
  import '@fontsource/jetbrains-mono/500.css';
  import '@fontsource/mr-dafoe/400.css';
  import '@fontsource/rubik/700.css';
  import '@fontsource/rubik/900.css';
  import wordmarkFont from '@fontsource/mr-dafoe/files/mr-dafoe-latin-400-normal.woff2?url';
  import '../app.css';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Footer from '$lib/components/Footer.svelte';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const CHANNELS: Record<string, string> = { nathan: "Nathan's", sandbox: 'The sandbox' };
  const notice = $derived.by(() => {
    const query = page.url.searchParams;
    if (query.get('signin') === 'denied') {
      return "That Google account isn't on the allowlist, so you're still signed out. Demo runs work without signing in.";
    }
    const connected = CHANNELS[query.get('connected') ?? ''];
    return connected ? `${connected} channel is connected.` : null;
  });
</script>

<svelte:head>
  <!-- The wordmark is the largest paint; fetch its font with the page instead of after the CSS. -->
  <link rel="preload" href={wordmarkFont} as="font" type="font/woff2" crossorigin="anonymous" />
  <meta
    name="description"
    content="Release agent for Flies Like Robots: self-hosted Gemma 4 watches and listens to a music video, then drafts and verifies the YouTube upload."
  />
</svelte:head>

<a class="skip" href="#content">Skip to content</a>

<div class="app">
  <div class="smear" aria-hidden="true"></div>

  <header>
    <h1 class="wordmark">
      <a href={resolve('/')}>Soundboard</a><small>Release agent · Flies Like Robots</small>
    </h1>
    <div class="bar">
      <!-- Channel stats are Nathan's dashboard; next to Sign in they read as a signed-in account. -->
      {#if data.channel && (data.session?.allowlisted || data.session?.demo)}
        <p class="chip">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
            ><path
              d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"
            /></svg
          >
          <b>{data.channel.handle}</b>
          <span>{data.channel.videoCount} videos · {data.channel.subscriberCount} subs</span>
        </p>
      {/if}
      {#if data.session?.allowlisted}
        <a class="btn ghost small" href={resolve('/brand')}>Brand guide</a>
      {/if}
      {#if data.session}
        <form method="POST" action="/auth/logout">
          <button class="btn ghost small" type="submit" title={data.session.email}>Sign out</button>
        </form>
      {:else}
        <a class="btn ghost small" href={resolve('/auth/login')} data-sveltekit-reload>Sign in</a>
      {/if}
    </div>
  </header>

  {#if data.session?.demo}
    <!-- Every page, not just the form: a demo run must never be mistaken for one on Nathan's channel. -->
    <aside class="demo" aria-label="Demo account">
      <strong>Demo account</strong>
      <span>Uploads go private to the sandbox channel. Nothing is saved to Nathan's memory.</span>
    </aside>
  {/if}

  {#if notice}
    <p class="notice" role="status">{notice}</p>
  {/if}

  <div id="content" class="content" tabindex="-1">
    {@render children()}
  </div>

  <Footer />
</div>

<style>
  .app {
    max-width: 1100px;
    margin: 0 auto;
    min-height: 100%;
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding-block: 16px 32px;
  }

  .smear {
    height: 14px;
    position: relative;
    overflow: hidden;
    box-shadow: 0 0 14px rgba(46, 140, 255, 0.35);
    background: linear-gradient(
      90deg,
      var(--blue) 0 38%,
      var(--orange) 38% 76%,
      var(--magenta) 76%
    );
  }

  .smear::after {
    content: '';
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      90deg,
      transparent 0 23px,
      var(--ground) 23px 27px,
      transparent 27px 61px,
      var(--ground) 61px 63px
    );
    opacity: 0.9;
  }

  /*
   * Fixed rows at every width, never wrapping by fit: if the controls dropped to a second row only
   * when they didn't fit, a web font arriving late would reflow the header and shift the page.
   * Phones always stack the controls under the wordmark.
   */
  header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px 16px;
  }

  @media (max-width: 640px) {
    header {
      grid-template-columns: minmax(0, 1fr);
    }

    .bar {
      justify-content: flex-start;
    }
  }

  .wordmark {
    min-width: 0;
    margin: 0;
    font: 400 clamp(52px, 8vw, 84px) / 0.9 var(--script);
    color: var(--magenta);
    text-shadow:
      0 0 18px rgba(255, 79, 216, 0.55),
      0 0 2px rgba(255, 79, 216, 0.9);
    letter-spacing: 0.01em;
  }

  .wordmark a {
    color: inherit;
    text-decoration: none;
  }

  .wordmark small {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font: 600 11px/1 var(--sans);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    text-shadow: none;
    margin: 8px 0 0 6px;
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: 10px;
  }

  .bar form {
    margin: 0;
  }

  .chip {
    margin: 0;
    min-height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px;
    border: 1px solid var(--line);
    font: 500 12px/1 var(--mono);
    color: var(--muted);
  }

  .chip svg {
    width: 16px;
    height: 16px;
  }

  .chip b {
    color: var(--ink);
    font-weight: 500;
  }

  .demo {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 14px;
    padding: 12px 16px;
    border: 2px solid var(--info);
    background: color-mix(in srgb, var(--info) 14%, var(--panel));
    font-size: 14px;
  }

  .demo strong {
    padding: 4px 10px;
    background: var(--info);
    color: var(--ground);
    font: 900 12px/1 var(--display);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .notice {
    margin: 0;
    padding: 10px 14px;
    border-left: 3px solid var(--info);
    background: var(--panel);
    font-size: 14px;
  }

  /* A real box, not display: contents, so the skip link can focus and scroll to it. */
  .content {
    display: block;
  }

  .content:focus {
    outline: none;
  }

  .skip {
    position: absolute;
    left: 16px;
    top: -48px;
    z-index: 10;
    padding: 10px 14px;
    background: var(--magenta);
    color: var(--ground);
    font: 900 13px/1 var(--display);
    text-decoration: none;
    transition: top 0.15s ease;
  }

  .skip:focus {
    top: 12px;
  }

  /* VHS tracking: the gaps in the smear drift slowly sideways. */
  .smear::after {
    animation: tracking 9s linear infinite;
  }

  @keyframes tracking {
    to {
      background-position: 126px 0;
    }
  }

  .wordmark {
    animation: flicker-on 1.4s ease-out both;
  }

  /* Starts and ends lit: the wordmark is the page's largest paint, so it must show at once. */
  @keyframes flicker-on {
    0%,
    12%,
    26%,
    100% {
      opacity: 1;
    }
    6%,
    20% {
      opacity: 0.35;
    }
  }
</style>

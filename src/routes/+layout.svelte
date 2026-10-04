<script lang="ts">
  import '../app.css';
  import { resolve } from '$app/paths';
  import { ago } from '$lib/format';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<svelte:head>
  <meta
    name="description"
    content="Release agent for Flies Like Robots: self-hosted Gemma 4 watches and listens to a music video, then drafts and verifies the YouTube upload."
  />
</svelte:head>

<div class="app">
  <div class="smear" aria-hidden="true"></div>

  <header>
    <h1 class="wordmark">
      <a href={resolve('/')}>Soundboard</a><small>Release agent · Flies Like Robots</small>
    </h1>
    <div class="channel">
      {#if data.channel}
        <span class="kicker">Public channel stats</span><br />
        <b>{data.channel.handle}</b><br />
        {data.channel.videoCount} videos · {data.channel.subscriberCount} subs{#if data.channel.lastUploadAt}
          · last upload {ago(data.channel.lastUploadAt)}{/if}
      {/if}
      <div class="who">
        {#if data.session}
          <span>{data.session.email}</span>
          <form method="POST" action="/auth/logout"><button type="submit">Sign out</button></form>
        {:else}
          <a href={resolve('/auth/login')} data-sveltekit-reload>Sign in</a>
        {/if}
      </div>
    </div>
  </header>

  {@render children()}

  <footer>
    <div class="tape-end" aria-hidden="true"></div>
    <div class="cols">
      <div class="about">
        <p class="lead">Built for Nathan. One file in, one upload out.</p>
        <p>Hacktoberfest Weekend Challenge · Build for a Friend</p>
        {#if data.session?.allowlisted}
          <p>
            <a href={resolve('/brand')}>Brand guide</a> · Connect channel:
            <a href="{resolve('/auth/login')}?connect=nathan" data-sveltekit-reload>Nathan</a> ·
            <a href="{resolve('/auth/login')}?connect=sandbox" data-sveltekit-reload>Sandbox</a>
          </p>
        {/if}
      </div>
      <div class="maker">
        <span class="label">Made by Ashley Childress</span>
        <nav class="links" aria-label="Ashley Childress">
          <!-- Icons from Simple Icons (CC0) and Lucide (ISC). The app runs inside the DEV iframe,
               so links open a new tab instead of replacing it. -->
          <a
            href="https://anchildress1.dev"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="anchildress1.dev"
            title="anchildress1.dev"
            ><svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              ><circle cx="12" cy="12" r="10" /><path
                d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"
              /><path d="M2 12h20" /></svg
            ></a
          >
          <a
            href="https://github.com/anchildress1"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
            title="GitHub"
            ><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
              ><path
                d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
              /></svg
            ></a
          >
          <a
            href="https://dev.to/anchildress1"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="DEV"
            title="DEV"
            ><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
              ><path
                d="M7.42 10.05c-.18-.16-.46-.23-.84-.23H6l.02 2.44.04 2.45.56-.02c.41 0 .63-.07.83-.26.24-.24.26-.36.26-2.2 0-1.91-.02-1.96-.29-2.18zM0 4.94v14.12h24V4.94H0zM8.56 15.3c-.44.58-1.06.77-2.53.77H4.71V8.53h1.4c1.67 0 2.16.18 2.6.9.27.43.29.6.32 2.57.05 2.23-.02 2.73-.47 3.3zm5.09-5.47h-2.47v1.77h1.52v1.28l-.72.04-.75.03v1.77l1.22.03 1.2.04v1.28h-1.6c-1.53 0-1.6-.01-1.87-.3l-.3-.28v-3.16c0-3.02.01-3.18.25-3.48.23-.31.25-.31 1.88-.31h1.64v1.3zm4.68 5.45c-.17.43-.64.79-1 .79-.18 0-.45-.15-.67-.39-.32-.32-.45-.63-.82-2.08l-.9-3.39-.45-1.67h.76c.4 0 .75.02.75.05 0 .06 1.16 4.54 1.26 4.83.04.15.32-.7.73-2.3l.66-2.52.74-.04c.4-.02.73 0 .73.04 0 .14-1.67 6.38-1.8 6.68z"
              /></svg
            ></a
          >
          <a
            href="https://www.linkedin.com/in/anchildress1"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="LinkedIn"
            title="LinkedIn"
            ><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
              ><path
                d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"
              /></svg
            ></a
          >
          <a
            href="https://x.com/anchildress1"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="X"
            title="X"
            ><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
              ><path
                d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"
              /></svg
            ></a
          >
        </nav>
      </div>
    </div>
  </footer>
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

  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }

  .wordmark {
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
    font: 600 11px/1 var(--sans);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    text-shadow: none;
    margin: 8px 0 0 6px;
  }

  .channel {
    font: 500 13px/1.4 var(--mono);
    color: var(--muted);
    text-align: right;
  }

  .channel .kicker {
    font: 900 10px/1 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .channel b {
    color: var(--ink);
    font-weight: 500;
  }

  .who {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    align-items: center;
    margin-top: 4px;
    font-size: 12px;
  }

  .who form {
    margin: 0;
  }

  .who button {
    background: none;
    border: 0;
    padding: 0;
    color: var(--info);
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
  }

  footer {
    margin-top: auto;
    padding-top: 24px;
    font: 500 11px/1.6 var(--mono);
    color: var(--muted);
  }

  .tape-end {
    height: 3px;
    margin-bottom: 16px;
    background: linear-gradient(
      90deg,
      var(--blue) 0 38%,
      var(--orange) 38% 76%,
      var(--magenta) 76%
    );
    opacity: 0.7;
  }

  .cols {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 16px 32px;
  }

  .about {
    flex: 1 1 320px;
  }

  .about p {
    margin: 0;
  }

  .about .lead {
    color: var(--ink);
  }

  .maker {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
  }

  .label {
    white-space: nowrap;
    font: 900 10px/1 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--orange);
  }

  .links {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .links a {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    color: var(--muted);
  }

  .links svg {
    width: 18px;
    height: 18px;
  }

  .links a:hover,
  .links a:focus-visible {
    color: var(--magenta);
  }
</style>

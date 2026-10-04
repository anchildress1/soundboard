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
          <!-- The app runs inside the DEV iframe, so links open a new tab instead of replacing it. -->
          <a href="https://anchildress1.dev" target="_blank" rel="noopener noreferrer"
            >anchildress1.dev</a
          >
          <a href="https://github.com/anchildress1" target="_blank" rel="noopener noreferrer"
            >GitHub</a
          >
          <a href="https://dev.to/anchildress1" target="_blank" rel="noopener noreferrer">DEV</a>
          <a
            href="https://www.linkedin.com/in/anchildress1"
            target="_blank"
            rel="noopener noreferrer">LinkedIn</a
          >
          <a href="https://x.com/anchildress1" target="_blank" rel="noopener noreferrer">X</a>
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
    align-items: flex-end;
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
    flex-direction: column;
    gap: 8px;
  }

  .label {
    font: 900 10px/1 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--orange);
  }

  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .links a {
    padding: 6px 10px;
    border: 1px solid var(--line);
    color: var(--muted);
    text-decoration: none;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .links a:hover,
  .links a:focus-visible {
    border-color: var(--magenta);
    color: var(--ink);
  }
</style>

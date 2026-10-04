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
    <span>Built for Nathan. One file in, one upload out.</span>
    {#if data.session?.allowlisted}
      <span>
        Connect channel:
        <a href="{resolve('/auth/login')}?connect=nathan" data-sveltekit-reload>Nathan</a> ·
        <a href="{resolve('/auth/login')}?connect=sandbox" data-sveltekit-reload>Sandbox</a>
      </span>
    {/if}
    <span>Hacktoberfest Weekend Challenge · Build for a Friend</span>
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
    font: 500 11px/1.5 var(--mono);
    color: var(--muted);
    display: flex;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding-top: 8px;
    margin-top: auto;
  }
</style>

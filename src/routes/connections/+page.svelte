<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { disconnectYouTube } from '$lib/api';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let busy = $state(false);
  let message = $state('');

  const NOTICES = {
    missing_scopes: "Google didn't grant upload and read access. Reconnect and allow both.",
    no_channel: 'That Google account has no YouTube channel. Create one, then reconnect.',
    mismatch: 'That connection attempt expired or started in another session. Try again.',
    'wrong-account': 'Connect YouTube with the Google account you signed in with.',
  };

  const FIXES = {
    missing_scopes: 'Upload and read access are missing. Reconnect and allow both.',
    no_channel: 'This Google account has no YouTube channel. Create one, then reconnect.',
    revoked: 'Access was removed. Reconnect to keep uploading.',
  };

  const UNCONFIRMED =
    "Removed here. Google didn't confirm. Remove Soundboard at myaccount.google.com/permissions.";

  const disconnect = async () => {
    busy = true;
    message = '';
    try {
      const { revokedAtGoogle } = await disconnectYouTube();
      if (!revokedAtGoogle) message = UNCONFIRMED;
      await invalidateAll();
    } catch (error) {
      message = error instanceof Error ? error.message : 'Disconnect failed';
    } finally {
      busy = false;
    }
  };
</script>

<svelte:head><title>Connections · Soundboard</title></svelte:head>

<main>
  <h2>Connections</h2>
  {#if data.notice}
    <p class="notice" role="status">{NOTICES[data.notice]}</p>
  {/if}
  <section class="row" aria-labelledby="youtube">
    <h3 id="youtube">YouTube</h3>
    {#if data.youtube?.status === 'connected'}
      <p>Connected to {data.youtube.channelTitle ?? 'your channel'}.</p>
      <button class="btn ghost small" type="button" disabled={busy} onclick={disconnect}
        >Disconnect</button
      >
    {:else}
      <p>{data.youtube ? FIXES[data.youtube.status] : 'Not connected.'}</p>
      <!-- A page load, not client routing: the route redirects to Google. -->
      <form method="GET" action="/auth/login" data-sveltekit-reload>
        <input type="hidden" name="connect" value="youtube" />
        <button class="btn primary small" type="submit"
          >{data.youtube ? 'Reconnect' : 'Connect'}</button
        >
      </form>
    {/if}
  </section>
  <p class="toast" aria-live="polite">{message}</p>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 640px;
  }

  h2,
  h3 {
    margin: 0;
    font: 900 12px/1 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--magenta);
  }

  h3 {
    color: var(--ink);
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px 16px;
    padding: 12px 14px;
    background: var(--panel);
  }

  .row h3 {
    grid-column: 1 / -1;
  }

  .row p {
    margin: 0;
    font-size: 14px;
    overflow-wrap: anywhere;
  }

  .row form {
    margin: 0;
  }

  .notice {
    margin: 0;
    padding: 12px 14px;
    border-left: 3px solid var(--yellow);
    background: var(--panel);
  }

  .toast {
    margin: 0;
    min-height: 1.4em;
    font: 500 12px/1.4 var(--mono);
    color: var(--muted);
  }
</style>

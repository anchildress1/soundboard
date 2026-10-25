<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
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
    failed: "Couldn't connect YouTube. Try again.",
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
  <a class="back" href={resolve('/')}>Releases</a>
  <div class="intro">
    <h1>Connections</h1>
    <p class="help">
      Where approved releases go. YouTube connects the Google account you signed in with: one
      channel per account, and a release never changes channel.
    </p>
  </div>
  {#if data.notice}
    <p class="notice" data-tone="warn" role="status">{NOTICES[data.notice]}</p>
  {/if}

  <div class="platforms">
    <section class="platform" aria-labelledby="youtube">
      <div class="body">
        <div class="name">
          <h2 id="youtube">YouTube</h2>
          {#if data.youtube?.status === 'connected'}
            <span class="chip" data-tone="ok"
              ><span class="dot" data-tone="ok"></span>Connected</span
            >
          {:else if data.youtube}
            <span class="chip" data-tone="warn"
              ><span class="dot" data-tone="warn"></span>Needs reconnecting</span
            >
          {:else}
            <span class="chip" data-tone="idle"
              ><span class="dot" data-tone="idle"></span>Not connected</span
            >
          {/if}
        </div>
        {#if data.youtube?.status === 'connected'}
          {@const name = data.youtube.channelTitle ?? 'your channel'}
          <p class="help">
            Connected to {#if data.youtube.channelId}<a
                href="https://www.youtube.com/channel/{data.youtube.channelId}"
                target="_blank"
                rel="noopener noreferrer">{name}</a
              >{:else}{name}{/if}.
          </p>
        {:else}
          <p class="help">{data.youtube ? FIXES[data.youtube.status] : 'Not connected.'}</p>
        {/if}
      </div>
      {#if data.youtube?.status === 'connected'}
        <button class="btn danger small" type="button" disabled={busy} onclick={disconnect}
          >Disconnect</button
        >
      {:else}
        <!-- A page load, not client routing: the route redirects to Google. -->
        <form method="GET" action="/auth/login" data-sveltekit-reload>
          <input type="hidden" name="connect" value="youtube" />
          <button class="btn primary small" type="submit"
            >{data.youtube ? 'Reconnect' : 'Connect'}</button
          >
        </form>
      {/if}
    </section>

    <section class="platform" aria-labelledby="bandcamp">
      <div class="body">
        <div class="name">
          <h2 id="bandcamp">Bandcamp</h2>
          <span class="chip">Copy &amp; paste</span>
        </div>
        <p class="help">
          No upload API for artist accounts. Each release drafts the track fields to copy into
          Bandcamp's editor.
        </p>
      </div>
      <span class="help">Nothing to connect</span>
    </section>

    <section class="platform" aria-labelledby="later">
      <div class="body">
        <div class="name">
          <h2 id="later">Instagram · TikTok</h2>
          <span class="chip">Coming later</span>
        </div>
        <p class="help">Not connectable yet.</p>
      </div>
    </section>
  </div>

  <section class="rules" aria-label="How connections work">
    <div class="panel">
      <h3>Bound to your sign-in</h3>
      <p class="help">Connecting YouTube from a different Google account is refused.</p>
    </div>
    <div class="panel">
      <h3>Disconnect pauses, never deletes</h3>
      <p class="help">
        Unfinished uploads and checks wait. Approved fields and progress are kept, and reconnecting
        the same channel picks up without a duplicate upload.
      </p>
    </div>
    <div class="panel">
      <h3>Access stays encrypted</h3>
      <p class="help">Only the app can read your YouTube grant. It is never shown or logged.</p>
    </div>
  </section>
  <p class="toast" aria-live="polite">{message}</p>
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
    max-width: 60ch;
    font-size: 16px;
  }

  .platforms {
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    background: var(--panel);
    overflow: hidden;
  }

  .platform {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px 20px;
    padding: 18px 20px;
  }

  .platform + .platform {
    border-top: 1px solid var(--line);
  }

  .body {
    flex: 1 1 320px;
    display: grid;
    gap: 6px;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  .name h2 {
    font: 600 16px/1.3 var(--font-body);
  }

  .platform form {
    margin: 0;
  }

  .rules {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
    gap: 16px;
  }

  .rules .panel {
    display: grid;
    align-content: start;
    gap: 6px;
  }
</style>

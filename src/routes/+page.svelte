<script lang="ts">
  import { resolve } from '$app/paths';
  import SignInNotice from '#lib/components/SignInNotice.svelte';
  import { groupReleases, STATE_LABELS } from '#lib/release.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const releases = $derived(groupReleases(data.jobs));
</script>

{#if data.user}
  <main class="home">
    {#if data.jobs.length === 0}
      <section class="panel lead" aria-labelledby="first-heading">
        <p class="kicker">Up next</p>
        <h1 id="first-heading">Upload your first video</h1>
        <p class="help">Here's the whole loop. It walks you through one step at a time.</p>
        <ol>
          <li>Pick the video and type the song title.</li>
          <li>The model listens and drafts a title, description, and tags.</li>
          <li>You keep each one, fix it, or ask for another draft.</li>
          <li>It uploads as Private and checks YouTube really has it.</li>
        </ol>
        <a class="btn primary" href={resolve('new')}>Start</a>
      </section>
    {:else}
      <h1 class="visually-hidden">Releases</h1>
      {#if releases.next}
        <section class="panel lead needs-you" aria-labelledby="next-heading">
          <p class="kicker">Up next</p>
          <h2 id="next-heading">Review the draft for {releases.next.songTitle}</h2>
          <p class="help">
            The title, description, and tags are drafted. Keep, fix, or redraft each one, then
            approve the upload.
          </p>
          <a
            class="btn primary"
            href={resolve('/jobs/[id]', { id: releases.next.id })}
            aria-label="Continue {releases.next.songTitle}">Continue</a
          >
        </section>
      {/if}

      {#each releases.running as job (job.id)}
        <!-- The browser does the first upload, so it only runs while the release's page is open. -->
        {@const uploading = job.state === 'AWAITING_UPLOAD'}
        <section class="running" aria-label={job.songTitle}>
          <div>
            <h2>{job.songTitle}</h2>
            <p class="help">
              <span class="dot" data-tone="running"></span>
              {STATE_LABELS[job.state].text} · {uploading
                ? 'open it to finish the upload'
                : 'nothing to do yet'}
            </p>
          </div>
          <a
            class="btn small"
            href={resolve('/jobs/[id]', { id: job.id })}
            aria-label="{uploading ? 'Open' : 'Watch'} {job.songTitle}"
            >{uploading ? 'Open' : 'Watch'}</a
          >
        </section>
      {/each}

      <div class="start">
        <a class="btn" class:primary={!releases.next} href={resolve('new')}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          Start a new release
        </a>
        <span class="help">Pick a video, type the song title. That's it.</span>
      </div>

      {#if releases.earlier.length > 0}
        <section class="earlier" aria-labelledby="earlier-heading">
          <h2 id="earlier-heading" class="kicker">Earlier</h2>
          <ul>
            {#each releases.earlier as job (job.id)}
              {@const state = STATE_LABELS[job.state]}
              <li>
                <span class="title">{job.songTitle}</span>
                <span class="state"
                  ><span class="dot" data-tone={state.tone}></span>{state.text}</span
                >
                <a
                  class="btn small"
                  href={resolve('/jobs/[id]', { id: job.id })}
                  aria-label="Open {job.songTitle}">Open</a
                >
              </li>
            {/each}
          </ul>
          <p class="help">Media is kept 7 days; everything you approved is kept.</p>
        </section>
      {/if}
    {/if}
  </main>
{:else}
  <main class="sign-in">
    <div class="intro">
      <h1>Sign in to Soundboard</h1>
      <p class="help">
        Upload a finished music video. The model drafts the title, description, and tags. You
        approve them, and it uploads as Private and reads the upload back to verify it.
      </p>
    </div>
    <SignInNotice />
    <div class="panel">
      <!-- A full page load: the login route redirects off-site to Google. -->
      <a class="btn primary" href={resolve('auth/login')} data-sveltekit-reload
        >Continue with Google</a
      >
      <p class="help">
        Signing in also connects your YouTube channel with upload and read access. Uploads go to the
        channel of the Google account you sign in with.
      </p>
    </div>
  </main>
{/if}

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 28px;
    width: 100%;
    max-width: calc(var(--measure-page) + 2 * var(--gutter));
    margin: 0 auto;
    padding: 40px var(--gutter) 64px;
  }

  .lead {
    display: grid;
    gap: 14px;
    justify-items: start;
    padding: 28px;
    border-radius: 16px;
  }

  .needs-you {
    border-color: var(--attention);
  }

  .needs-you .kicker {
    color: var(--attention);
  }

  .lead h2 {
    font-size: clamp(24px, 4.5vw, 30px);
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }

  ol {
    display: grid;
    gap: 8px;
    margin: 0;
    padding-left: 20px;
  }

  .running {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding: 16px 20px;
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
  }

  .running h2,
  .title {
    font: 600 16px/1.4 var(--font-body);
    overflow-wrap: anywhere;
  }

  .running .help,
  .state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .start {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 16px;
  }

  .start svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
  }

  .earlier {
    display: grid;
    gap: 10px;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    overflow: hidden;
  }

  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 6px 16px;
    padding: 12px 20px;
  }

  li + li {
    border-top: 1px solid var(--line);
  }

  .state {
    font-size: 14px;
    color: var(--muted);
  }

  /* Phones: the state drops under the title; the button keeps its row. */
  @media (width < 560px) {
    li {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .state {
      grid-row: 2;
    }
  }

  .sign-in {
    max-width: calc(440px + 2 * var(--gutter));
    justify-content: center;
    flex: 1;
  }

  .intro {
    display: grid;
    gap: 10px;
  }

  .sign-in .panel {
    display: grid;
    gap: 14px;
    padding: 24px;
  }
</style>

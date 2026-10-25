<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onDestroy } from 'svelte';
  import { ApiError, createJob } from '#lib/api.js';
  import Monitor from '#lib/components/Monitor.svelte';
  import ReleaseBar from '#lib/components/ReleaseBar.svelte';
  import { fingerprint } from '#lib/fingerprint.js';
  import { TITLE_MAX } from '#lib/metadata.js';
  import { acquire, start as startUpload } from '#lib/upload.js';

  const maxMinutes = 15;

  let file = $state<File | null>(null);
  let objectUrl = $state<string | null>(null);
  let duration = $state(0);
  let songTitle = $state('');
  let notes = $state('');
  let busy = $state(false);
  let message = $state('');

  const tooLong = $derived(duration > maxMinutes * 60);
  const picked = $derived(Boolean(file) && duration > 0 && songTitle.trim().length > 0);
  const canStart = $derived(picked && !tooLong && !busy);

  const pick = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const chosen = input.files?.[0] ?? null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    file = chosen;
    duration = 0;
    message = '';
    // The monitor plays the local file at once, while the upload runs.
    objectUrl = chosen ? URL.createObjectURL(chosen) : null;
  };

  const start = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!file || !canStart) return;
    busy = true;
    message = '';
    const print = await fingerprint(file).catch(() => null);
    if (!print) {
      message = "Couldn't read this video. Pick it again.";
      busy = false;
      return;
    }
    try {
      const { id, sessionUri, generation } = await createJob({
        songTitle: songTitle.trim(),
        notes: notes.trim(),
        filename: file.name,
        size: file.size,
        durationSec: duration,
        // Browsers report an empty type for some containers.
        contentType: file.type || 'video/mp4',
        fingerprint: print,
      });
      // No other tab knows the job yet, so the lock is free.
      await acquire(id);
      startUpload(id, { file, sessionUri, generation, fingerprint: print });
      await goto(resolve('/jobs/[id]', { id }));
    } catch (error) {
      message = error instanceof ApiError ? error.message : 'Could not start the release.';
      busy = false;
    }
  };

  onDestroy(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
</script>

<svelte:head><title>New release · Soundboard</title></svelte:head>

<ReleaseBar title="New release" step={0} />

<main class="step">
  <div class="intro">
    <h1>Pick the finished video</h1>
    <p class="help">
      Up to {maxMinutes} minutes. It plays here the moment you choose it, so you can check it's the right
      cut.
    </p>
  </div>

  <form onsubmit={start} aria-label="Start a release">
    <div class="field" class:err={tooLong}>
      <label for="video" class="drop" class:chosen={file}>
        {#if file}
          <span>{file.name}</span>
          <span class="help">Choose a different file</span>
        {:else}
          <svg viewBox="0 0 24 24" aria-hidden="true"
            ><path d="M12 16V4M7 9l5-5 5 5" /><path
              d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"
            /></svg
          >
          <span>Choose the video</span>
          <span class="help">Any video file, up to {maxMinutes} min</span>
        {/if}
      </label>
      <input
        id="video"
        class="visually-hidden"
        type="file"
        accept="video/*"
        onchange={pick}
        disabled={busy}
      />
      {#if tooLong}<span class="msg">This video runs over {maxMinutes} minutes.</span>{/if}
    </div>

    {#if objectUrl}
      <Monitor src={objectUrl} filename={file?.name ?? ''} bind:duration />
    {/if}

    <div class="field">
      <label for="song">What's the song called?</label>
      <input
        id="song"
        bind:value={songTitle}
        maxlength={TITLE_MAX}
        autocomplete="off"
        required
        disabled={busy}
      />
      <span class="msg">That's the only thing the model needs from you.</span>
    </div>
    <div class="field">
      <label for="notes">Anything it should know? <span>optional</span></label>
      <textarea
        id="notes"
        rows="3"
        bind:value={notes}
        maxlength="1000"
        disabled={busy}
        placeholder="Who played on it, where it was shot, what not to mention."></textarea>
    </div>
    <div class="actions">
      <button class="btn primary" type="submit" disabled={!canStart}
        >{busy ? 'Starting' : 'Start the release'}</button
      >
      <span class="help">Goes to YouTube as Private, after you approve it.</span>
    </div>
    <p class="toast err" aria-live="polite">{message}</p>
  </form>
</main>

<style>
  .step,
  form {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .step {
    width: 100%;
    max-width: calc(var(--measure-step) + 2 * var(--gutter));
    margin: 0 auto;
    padding: 32px var(--gutter) 64px;
  }

  .intro {
    display: grid;
    gap: 8px;
  }

  .intro .help {
    font-size: 16px;
  }

  /* The label is the target; the input stays focusable, so its focus ring shows here. */
  .drop {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 200px;
    padding: 24px;
    border: 1px dashed var(--edge);
    border-radius: var(--radius-panel);
    background: var(--panel);
    font-size: 17px;
    text-align: center;
    cursor: pointer;
    overflow-wrap: anywhere;
  }

  .drop.chosen {
    min-height: 0;
    border-style: solid;
  }

  .field:has(input:focus-visible) .drop {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .drop svg {
    width: 30px;
    height: 30px;
    fill: none;
    stroke: var(--action);
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 16px;
  }

  /* Phones: the one action is pinned to the bottom of the screen. */
  @media (width < 560px) {
    .actions {
      position: sticky;
      bottom: 0;
      margin-inline: calc(-1 * var(--gutter));
      padding: 12px var(--gutter) 20px;
      border-top: 1px solid var(--line);
      background: var(--ground);
    }

    .actions .btn {
      flex: 1;
    }
  }
</style>

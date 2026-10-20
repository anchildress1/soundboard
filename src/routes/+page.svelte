<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onDestroy } from 'svelte';
  import { ApiError, createJob } from '$lib/api';
  import Heard from '$lib/components/Heard.svelte';
  import JobList from '$lib/components/JobList.svelte';
  import Monitor from '$lib/components/Monitor.svelte';
  import SignInNotice from '$lib/components/SignInNotice.svelte';
  import { setPending } from '$lib/pending';
  import { TITLE_MAX } from '$lib/metadata';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

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
    if (!file || !objectUrl || !canStart) return;
    busy = true;
    message = '';
    // Browsers report an empty type for some containers; the URL is signed with this exact value.
    const contentType = file.type || 'video/mp4';
    try {
      const { id, uploadUrl } = await createJob({
        songTitle: songTitle.trim(),
        notes: notes.trim(),
        filename: file.name,
        size: file.size,
        durationSec: duration,
        contentType,
      });
      setPending(id, { file, uploadUrl, objectUrl, contentType });
      objectUrl = null;
      await goto(resolve('/jobs/[id]', { id }));
    } catch (error) {
      message = error instanceof ApiError ? error.message : 'Could not start the run.';
      busy = false;
    }
  };

  onDestroy(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
</script>

{#if data.user}
  <main>
    <section class="tape" aria-label="The video">
      <Monitor src={objectUrl} filename={file?.name ?? ''} bind:duration />
      <Heard tags={[]} measurements={null} />
    </section>

    <div class="side">
      <form class="label" onsubmit={start} aria-label="Start a run">
        <div class="field" class:err={tooLong}>
          <label for="video">Video <span>up to {maxMinutes} min</span></label>
          <input id="video" type="file" accept="video/*" onchange={pick} disabled={busy} />
          {#if tooLong}<span class="msg">This video runs over {maxMinutes} minutes.</span>{/if}
        </div>
        <div class="field">
          <label for="song">Song title <span>required</span></label>
          <input
            id="song"
            bind:value={songTitle}
            maxlength={TITLE_MAX}
            autocomplete="off"
            required
            disabled={busy}
          />
        </div>
        <div class="field">
          <label for="notes">Notes <span>optional</span></label>
          <textarea id="notes" rows="3" bind:value={notes} maxlength="1000" disabled={busy}
          ></textarea>
        </div>
        <div class="actions">
          <button class="btn primary" type="submit" disabled={!canStart}
            >{busy ? 'Starting' : 'Analyze'}</button
          >
        </div>
        <p class="toast" aria-live="polite">{message}</p>
      </form>
      <JobList jobs={data.jobs} />
    </div>
  </main>
{:else}
  <SignInNotice />
{/if}

<style>
  main {
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
    gap: 20px;
    align-items: start;
  }

  @media (max-width: 820px) {
    main {
      grid-template-columns: 1fr;
    }
  }

  .tape,
  .side,
  .label {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    border-top: 1px solid var(--line);
    padding-top: 16px;
  }

  .toast {
    font: 500 12px/1.4 var(--mono);
    color: var(--red-text);
    min-height: 1.4em;
    margin: 0;
  }
</style>

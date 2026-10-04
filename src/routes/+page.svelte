<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onDestroy } from 'svelte';
  import { ApiError, createJob } from '$lib/api';
  import Heard from '$lib/components/Heard.svelte';
  import Monitor from '$lib/components/Monitor.svelte';
  import { setPending } from '$lib/pending';
  import { TITLE_MAX } from '$lib/metadata';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const maxMinutes = $derived(data.session?.allowlisted ? 15 : 5);

  let file = $state<File | null>(null);
  let objectUrl = $state<string | null>(null);
  let duration = $state(0);
  let songTitle = $state('');
  let notes = $state('');
  let busy = $state(false);
  let message = $state('');

  const tooLong = $derived(duration > maxMinutes * 60);
  const canStart = $derived(
    Boolean(file) && songTitle.trim().length > 0 && duration > 0 && !tooLong && !busy,
  );

  function pick(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const chosen = input.files?.[0] ?? null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    file = chosen;
    duration = 0;
    message = '';
    // The monitor plays the local file at once, while the upload runs.
    objectUrl = chosen ? URL.createObjectURL(chosen) : null;
  }

  async function start(event: SubmitEvent) {
    event.preventDefault();
    if (!file || !objectUrl || !canStart) return;
    busy = true;
    message = '';
    try {
      const { id, uploadUrl } = await createJob({
        songTitle: songTitle.trim(),
        notes: notes.trim(),
        filename: file.name,
        contentType: file.type || 'video/mp4',
        size: file.size,
        durationSec: duration,
      });
      if (uploadUrl) setPending(id, { file, uploadUrl, objectUrl });
      objectUrl = null;
      await goto(resolve('/jobs/[id]', { id }));
    } catch (error) {
      message = error instanceof ApiError ? error.message : 'Could not start the run.';
      busy = false;
    }
  }

  async function runSample(sampleId: string) {
    busy = true;
    message = '';
    try {
      const { id } = await createJob({ sampleId });
      await goto(resolve('/jobs/[id]', { id }));
    } catch (error) {
      message = error instanceof ApiError ? error.message : 'Could not start the sample.';
      busy = false;
    }
  }

  onDestroy(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
</script>

<main>
  <section class="tape" aria-label="The video">
    <Monitor src={objectUrl} filename={file?.name ?? ''} bind:duration />
    {#if data.samples.length > 0}
      <div class="samples">
        <h2>Samples <span>30 seconds · one tap</span></h2>
        <ul>
          {#each data.samples as sample (sample.id)}
            <li>
              <button
                class="btn ghost"
                type="button"
                disabled={busy}
                onclick={() => runSample(sample.id)}
              >
                {sample.songTitle}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    <Heard tags={[]} measurements={null} />
  </section>

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
      <textarea id="notes" rows="3" bind:value={notes} maxlength="1000" disabled={busy}></textarea>
    </div>
    {#if !data.session?.allowlisted}
      <p class="note">
        Signed out: your own video ends at the would-be upload payload; nothing is posted.
      </p>
    {/if}
    <div class="actions">
      <button class="btn primary" type="submit" disabled={!canStart}
        >{busy ? 'Starting' : 'Analyze'}</button
      >
    </div>
    <p class="toast" aria-live="polite">{message}</p>
  </form>
</main>

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
  .label {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }

  .samples h2 {
    margin: 0 0 8px;
    font: 900 12px/1 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--magenta);
  }

  .samples h2 span {
    font: 500 11px/1 var(--mono);
    letter-spacing: 0;
    text-transform: none;
    color: var(--muted);
    margin-left: 6px;
  }

  .samples ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .note {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
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

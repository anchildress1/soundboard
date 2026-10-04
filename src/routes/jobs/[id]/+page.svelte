<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { action, ApiError, step, uploadToGcs } from '$lib/api';
  import Diff from '$lib/components/Diff.svelte';
  import Heard from '$lib/components/Heard.svelte';
  import Label from '$lib/components/Label.svelte';
  import Monitor from '$lib/components/Monitor.svelte';
  import Track from '$lib/components/Track.svelte';
  import { drive, sleep } from '$lib/driver';
  import type { FieldErrors } from '$lib/metadata';
  import { takePending } from '$lib/pending';
  import { heardTags, jobStatus, lastModelSeconds } from '$lib/status';
  import { DRIVEN_STATES, type JobView, type PickFields } from '$lib/types';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // svelte-ignore state_referenced_locally
  let view = $state<JobView>(data.view);
  let uploadPct = $state(0);
  let localUrl = $state<string | null>(null);
  let busy = $state(false);
  let message = $state('');
  let serverErrors = $state<FieldErrors>({});
  let stopped = false;
  let driving = false;

  const job = $derived(view.job);
  const status = $derived(jobStatus(view, view.wait, uploadPct));
  const seconds = $derived(lastModelSeconds(view));
  const model = $derived(seconds ? `gemma-4-12b-it · ${seconds}s` : 'gemma-4-12b-it');
  const fields = $derived<PickFields | null>(
    job.payload ??
      (view.pick
        ? {
            title: view.pick.title,
            description: view.pick.description,
            hashtags: view.pick.hashtags,
            tags: view.pick.tags,
          }
        : null),
  );
  const editable = $derived(job.state === 'REVIEW');
  const done = $derived(['PUBLISHING', 'CLAIMED_COMPLETE', 'VERIFIED'].includes(job.state));

  async function run() {
    if (driving) return;
    driving = true;
    try {
      await drive(view, {
        step: () => step(job.id, data.trace),
        sleep,
        stopped: () => stopped,
        onView: (next) => {
          view = next;
          message = next.job.error ?? '';
        },
        onError: (text) => (message = text),
      });
    } finally {
      driving = false;
    }
  }

  async function act(name: 'approve' | 'rerun' | 'discard' | 'retry', body: unknown = {}) {
    busy = true;
    message = '';
    serverErrors = {};
    try {
      view = await action(job.id, name, data.trace, body);
      message = view.job.error ?? '';
      if (DRIVEN_STATES.includes(view.job.state)) void run();
    } catch (error) {
      message = error instanceof Error ? error.message : 'Action failed';
      if (error instanceof ApiError && error.fields) serverErrors = error.fields;
    } finally {
      busy = false;
    }
  }

  onMount(async () => {
    if (job.state !== 'AWAITING_UPLOAD') {
      void run();
      return;
    }
    const pending = takePending(job.id);
    if (!pending) {
      // A reload mid-upload loses the file; the upload may still have landed.
      view = await step(job.id, data.trace).catch(() => view);
      if (view.job.state === 'AWAITING_UPLOAD')
        message = 'The upload was interrupted. Start a new run from the home page.';
      else void run();
      return;
    }
    localUrl = pending.objectUrl;
    try {
      await uploadToGcs(
        pending.uploadUrl,
        pending.file,
        pending.contentType,
        (pct) => (uploadPct = pct),
      );
      for (let i = 0; i < 5 && view.job.state === 'AWAITING_UPLOAD' && !stopped; i++) {
        view = await step(job.id, data.trace);
        if (view.job.state === 'AWAITING_UPLOAD') await sleep(1000);
      }
      void run();
    } catch (error) {
      message = error instanceof Error ? error.message : 'Upload failed';
    }
  });

  onDestroy(() => {
    stopped = true;
    if (localUrl) URL.revokeObjectURL(localUrl);
  });
</script>

<main>
  <section class="tape" aria-label="The video">
    <Monitor
      src={localUrl ?? data.playbackUrl}
      filename={job.filename}
      height={job.probe?.height}
    />
    <Track {status} {model} />
    {#if job.state === 'VERIFIED' && job.videoId}
      <p class="verified">
        Verified · private · <a href="https://youtu.be/{job.videoId}" target="_blank" rel="noopener"
          >youtu.be/{job.videoId}</a
        >
      </p>
    {/if}
    <Heard tags={heardTags(view)} measurements={job.measurements} />
    {#if data.live && view.pick}
      <Diff live={data.live} pick={view.pick} />
    {/if}
  </section>

  <div class="right">
    {#if fields && view.pick}
      {#key view.pick.version}
        <Label
          {fields}
          candidates={job.hashtagCandidates ?? []}
          {editable}
          {busy}
          {done}
          {serverErrors}
          onapprove={(f) => act('approve', f)}
          onrerun={() => act('rerun')}
          ondiscard={() => act('discard')}
        />
      {/key}
      {#if view.pick.flags.length > 0 || view.pick.brandCheck}
        <div class="notes">
          {#if view.pick.flags.length > 0}
            <h2>Flags</h2>
            <ul>
              {#each view.pick.flags as flag (flag)}<li>{flag}</li>{/each}
            </ul>
          {/if}
          {#if view.pick.brandCheck}
            <h2>Brand check</h2>
            <p>{view.pick.brandCheck}</p>
          {/if}
        </div>
      {/if}
    {:else}
      <section class="placeholder" aria-label="What goes to YouTube">
        <h2>{job.songTitle}</h2>
        <p>The recommendation appears here once every chunk is analyzed.</p>
      </section>
    {/if}

    {#if job.state === 'PAYLOAD' && job.payload}
      <section class="payload" aria-label="Would-be upload payload">
        <h2>Would-be payload</h2>
        <pre>{JSON.stringify(
            {
              snippet: {
                title: job.payload.title,
                description: job.payload.description,
                tags: job.payload.tags,
                categoryId: '10',
              },
              status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
            },
            null,
            2,
          )}</pre>
      </section>
    {/if}

    {#if job.state === 'FAILED'}
      <div class="actions">
        <button class="btn ghost" type="button" disabled={busy} onclick={() => act('discard')}
          >Discard</button
        >
        <button class="btn primary" type="button" disabled={busy} onclick={() => act('retry')}
          >Retry</button
        >
      </div>
    {/if}
    <p class="toast" aria-live="polite">{message}</p>
  </div>
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
  .right {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }

  .verified {
    margin: 0;
    font: 500 13px/1.4 var(--mono);
    color: var(--green);
  }

  .placeholder,
  .notes,
  .payload {
    background: var(--panel);
    padding: 12px 14px;
  }

  h2 {
    margin: 0 0 6px;
    font: 900 12px/1.2 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .placeholder h2 {
    font-size: 18px;
    letter-spacing: 0.04em;
    color: var(--ink);
  }

  .placeholder p,
  .notes p {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .notes ul {
    margin: 0 0 10px;
    padding-left: 18px;
    font-size: 13px;
    color: var(--yellow);
  }

  .payload pre {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: 500 12px/1.5 var(--mono);
    color: var(--ink);
  }

  .actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }

  .toast {
    font: 500 12px/1.4 var(--mono);
    color: var(--muted);
    min-height: 1.4em;
    margin: 0;
  }
</style>

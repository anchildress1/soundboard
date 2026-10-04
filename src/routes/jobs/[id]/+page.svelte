<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { action, ApiError, step, uploadToGcs, type ActionName } from '$lib/api';
  import Bandcamp from '$lib/components/Bandcamp.svelte';
  import Destinations from '$lib/components/Destinations.svelte';
  import Diff from '$lib/components/Diff.svelte';
  import Heard from '$lib/components/Heard.svelte';
  import Label from '$lib/components/Label.svelte';
  import Monitor from '$lib/components/Monitor.svelte';
  import Payload from '$lib/components/Payload.svelte';
  import Short from '$lib/components/Short.svelte';
  import Track from '$lib/components/Track.svelte';
  import { drive, sleep } from '$lib/driver';
  import type { FieldErrors } from '$lib/metadata';
  import { takePending } from '$lib/pending';
  import { heardTags, jobStatus, modelSeconds, modelWorking } from '$lib/status';
  import { canCutShort, SHORT_MIN_SEC } from '$lib/short';
  import { DRIVEN_STATES, SHORT_SOURCE_STATES, type JobView, type PickFields } from '$lib/types';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // svelte-ignore state_referenced_locally
  let view = $state<JobView>(data.view);
  let uploadPct = $state(0);
  let localUrl = $state<string | null>(null);
  let busy = $state(false);
  // svelte-ignore state_referenced_locally
  let message = $state(data.view.job.error ?? '');
  let serverErrors = $state<FieldErrors>({});
  let bandcampDone = $state(false);
  // Finished calls only land in the view when their step returns, so the clock covers the gap.
  let stepStartedAt = $state(Date.now());
  let now = $state(Date.now());
  let stopped = false;
  let driving = false;

  // svelte-ignore state_referenced_locally
  let shortView = $state<JobView | null>(data.short);
  // svelte-ignore state_referenced_locally
  let shortSrc = $state<string | null>(data.short?.playbackUrl ?? null);
  let shortBusy = $state(false);
  // svelte-ignore state_referenced_locally
  let shortMessage = $state(data.short?.job.error ?? '');
  let shortErrors = $state<FieldErrors>({});
  let drivingShort = false;

  const job = $derived(view.job);
  const status = $derived(jobStatus(view, view.wait, uploadPct));
  const working = $derived(modelWorking(view));
  const seconds = $derived(modelSeconds(view, working ? Math.max(0, now - stepStartedAt) : 0));
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
  const canMakeShort = $derived(SHORT_SOURCE_STATES.includes(job.state));
  const tooShortForShort = $derived(!!job.probe && !canCutShort(job.probe.durationSec));

  // Reading `view` reruns this whenever a new view lands.
  $effect(() => {
    if (view) stepStartedAt = now = Date.now();
  });

  $effect(() => {
    const tick = working ? setInterval(() => (now = Date.now()), 1000) : undefined;
    return () => clearInterval(tick);
  });

  const run = async () => {
    if (driving) return;
    driving = true;
    try {
      await drive(view, {
        step: () => step(job.id, data.trace),
        stopped: () => stopped,
        onView: (next) => {
          view = next;
          message = next.job.error ?? '';
        },
        onError: (text) => (message = text),
        sleep,
      });
    } finally {
      driving = false;
    }
  };

  /** Signed URLs change on every response; the player only reloads for a new render. */
  const showShort = (next: JobView) => {
    const renders = shortView?.job.short?.renders;
    shortView = next;
    if (next.playbackUrl && (next.job.short?.renders !== renders || !shortSrc)) {
      shortSrc = next.playbackUrl;
    }
  };

  const runShort = async () => {
    if (drivingShort || !shortView) return;
    drivingShort = true;
    const id = shortView.job.id;
    try {
      await drive(shortView, {
        step: () => step(id, data.trace),
        stopped: () => stopped || shortView?.job.id !== id,
        onView: (next) => {
          showShort(next);
          shortMessage = next.job.error ?? '';
        },
        onError: (text) => (shortMessage = text),
        sleep,
      });
    } finally {
      drivingShort = false;
    }
  };

  const actShort = async (name: ActionName, body: unknown = {}) => {
    shortBusy = true;
    shortMessage = '';
    shortErrors = {};
    try {
      const target = name === 'short' ? job.id : shortView?.job.id;
      if (!target) return;
      const next = await action(target, name, data.trace, body);
      if (next.job.state === 'DISCARDED') {
        shortView = null;
        shortSrc = null;
        return;
      }
      showShort(next);
      shortMessage = next.job.error ?? '';
      if (DRIVEN_STATES.includes(next.job.state)) void runShort();
    } catch (error) {
      shortMessage = error instanceof Error ? error.message : 'Action failed';
      if (error instanceof ApiError && error.fields) shortErrors = error.fields;
    } finally {
      shortBusy = false;
    }
  };

  const act = async (name: Exclude<ActionName, 'recut' | 'short'>, body: unknown = {}) => {
    busy = true;
    message = '';
    serverErrors = {};
    try {
      view = await action(job.id, name, data.trace, body);
      if (view.job.state === 'DISCARDED') {
        await goto(resolve('/'));
        return;
      }
      message = view.job.error ?? '';
      if (DRIVEN_STATES.includes(view.job.state)) void run();
    } catch (error) {
      message = error instanceof Error ? error.message : 'Action failed';
      if (error instanceof ApiError && error.fields) serverErrors = error.fields;
    } finally {
      busy = false;
    }
  };

  /** A reload mid-upload loses the file; the upload may still have landed. */
  const resumeAfterReload = async () => {
    view = await step(job.id, data.trace).catch(() => view);
    if (view.job.state === 'AWAITING_UPLOAD') {
      message = 'The upload was interrupted. Start a new run from the home page.';
    } else {
      void run();
    }
  };

  const finishUpload = async () => {
    const pending = takePending(job.id);
    if (!pending) {
      await resumeAfterReload();
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
  };

  onMount(() => {
    if (shortView && DRIVEN_STATES.includes(shortView.job.state)) void runShort();
    if (job.state === 'AWAITING_UPLOAD') void finishUpload();
    else void run();
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
      width={job.probe?.width}
      height={job.probe?.height}
    />
    <Track {status} {model} />
    <Heard tags={heardTags(view)} measurements={job.measurements} />
    {#if data.live && view.pick}
      <Diff live={data.live} pick={view.pick} />
    {/if}
  </section>

  <div class="right">
    {#if fields && view.pick}
      {@const pick = view.pick}
      {#if pick.flags.length > 0}
        <!-- Above both tabs: an audio or video problem matters wherever the song goes. -->
        <section class="warning" aria-labelledby="warning-title">
          <h2 id="warning-title"><span aria-hidden="true">⚠</span> Check before uploading</h2>
          <ul>
            {#each pick.flags as flag (flag)}<li>{flag}</li>{/each}
          </ul>
        </section>
      {/if}
      <Destinations
        youtubeDone={job.state === 'VERIFIED'}
        shortDone={shortView?.job.state === 'VERIFIED'}
        {bandcampDone}
      >
        {#snippet youtube()}
          {#if job.state === 'VERIFIED' && job.videoId}
            <p class="uploaded">
              <span class="check" aria-hidden="true">✓</span>
              <span
                >Uploaded to YouTube · private ·
                <a href="https://youtu.be/{job.videoId}" target="_blank" rel="noopener"
                  >youtu.be/{job.videoId}</a
                ></span
              >
            </p>
          {/if}
          {#key pick.version}
            <Label
              {fields}
              candidates={job.hashtagCandidates ?? []}
              {editable}
              {busy}
              {done}
              {serverErrors}
              onapprove={(f) => act('approve', { ...f, pickVersion: pick.version })}
              onrerun={() => act('rerun')}
              ondiscard={() => act('discard')}
            />
          {/key}
          {#if job.state === 'PAYLOAD' && job.payload}
            <Payload fields={job.payload} />
          {/if}
        {/snippet}
        {#snippet short()}
          {#if shortView}
            <Short
              view={shortView}
              src={shortSrc}
              busy={shortBusy}
              message={shortMessage}
              serverErrors={shortErrors}
              onrecut={(cut) => actShort('recut', cut)}
              onapprove={(f) =>
                actShort('approve', { ...f, pickVersion: shortView?.pick?.version })}
              onrerun={() => actShort('rerun')}
              ondiscard={() => actShort('discard')}
              onretry={() => actShort('retry')}
            />
          {:else}
            <section class="placeholder make" aria-labelledby="make-short-heading">
              <h2 id="make-short-heading">Short</h2>
              <p>
                A vertical cut of this video's hook for YouTube Shorts. The model picks the hook;
                ffmpeg cuts it and fits it to 9:16. It starts from this video's title, description,
                and tags.
              </p>
              {#if tooShortForShort}
                <p>A Short needs a video of at least {SHORT_MIN_SEC} seconds.</p>
              {:else if canMakeShort}
                <button
                  class="btn primary"
                  type="button"
                  disabled={shortBusy}
                  onclick={() => actShort('short')}>Make a Short</button
                >
              {:else}
                <p>Available once the recommendation is ready.</p>
              {/if}
              <p class="toast" aria-live="polite">{shortMessage}</p>
            </section>
          {/if}
        {/snippet}
        {#snippet bandcamp()}
          <Bandcamp
            jobId={job.id}
            songTitle={job.songTitle}
            {pick}
            tags={fields.tags}
            ondone={(d) => (bandcampDone = d)}
          />
        {/snippet}
      </Destinations>
    {:else}
      <section class="placeholder" aria-label="What goes to YouTube">
        <h2>{job.songTitle}</h2>
        <p>The recommendation appears here once every chunk is analyzed.</p>
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

  /* Phones read top to bottom: the video and what the model heard, then the tabs. */
  @media (max-width: 820px) {
    main {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .tape,
  .right {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }

  .uploaded {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid var(--green);
    border-left-width: 4px;
    background: color-mix(in srgb, var(--green) 8%, var(--panel));
    font: 600 14px/1.4 var(--sans);
    color: var(--ink);
  }

  .uploaded .check {
    display: grid;
    place-items: center;
    flex: none;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--green);
    color: var(--ground);
    font-size: 14px;
  }

  .uploaded a {
    color: var(--green);
  }

  .placeholder {
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

  /* Yellow is the "needs attention" state color; it stays clear of the orange panel labels. */
  .warning {
    padding: 12px 14px;
    border: 1px solid var(--yellow);
    border-left-width: 4px;
    background: color-mix(in srgb, var(--yellow) 8%, var(--panel));
  }

  .warning h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--yellow);
  }

  .warning h2 span {
    font-size: 16px;
    letter-spacing: 0;
  }

  .warning ul {
    margin: 0;
    padding-left: 18px;
    font-size: 14px;
    color: var(--ink);
  }

  .placeholder h2 {
    font-size: 18px;
    letter-spacing: 0.04em;
    color: var(--ink);
  }

  .placeholder p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: 500 12px/1.5 var(--mono);
    color: var(--ink);
  }

  .make {
    display: grid;
    gap: 12px;
    justify-items: start;
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

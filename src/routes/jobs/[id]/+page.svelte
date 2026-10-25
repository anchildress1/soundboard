<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { action, ApiError, step, uploadToGcs, type ActionName } from '#lib/api.js';
  import Bandcamp from '#lib/components/Bandcamp.svelte';
  import Heard from '#lib/components/Heard.svelte';
  import Monitor from '#lib/components/Monitor.svelte';
  import ReleaseBar from '#lib/components/ReleaseBar.svelte';
  import Review from '#lib/components/Review.svelte';
  import Short from '#lib/components/Short.svelte';
  import UploadRecovery from '#lib/components/UploadRecovery.svelte';
  import Track from '#lib/components/Track.svelte';
  import pRetry, { AbortError } from 'p-retry';
  import { clearDraft, draftKey } from '#lib/draft.js';
  import { drive } from '#lib/driver.js';
  import type { FieldErrors } from '#lib/metadata.js';
  import { takePending } from '#lib/pending.js';
  import { POLL_BACKOFF, Waiting } from '#lib/retry.js';
  import {
    heardTags,
    jobStatus,
    modelLabel,
    modelSeconds,
    modelWorking,
    publishPaused,
  } from '#lib/status.js';
  import { stepIndex, workCopy, type ReviewStep } from '#lib/release.js';
  import { canCutShort, SHORT_MIN_SEC } from '#lib/short.js';
  import { DRIVEN_STATES, type JobView, type PickFields } from '#lib/types.js';
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
  let reviewStep = $state<ReviewStep>('title');
  /** The YouTube release, or one of the side trips offered once it's approved. */
  let room = $state<'release' | 'short' | 'bandcamp'>('release');
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
  let drivingShort: string | null = null;

  const job = $derived(view.job);
  const working = $derived(modelWorking(view));
  const seconds = $derived(modelSeconds(view, working ? Math.max(0, now - stepStartedAt) : 0));
  const model = $derived(modelLabel(view));
  const fields = $derived<PickFields | null>(
    job.finalFields ??
      (view.pick
        ? {
            title: view.pick.title,
            description: view.pick.description,
            hashtags: view.pick.hashtags,
            tags: view.pick.tags,
          }
        : null),
  );
  const approved = $derived(['PUBLISHING', 'CLAIMED_COMPLETE', 'VERIFIED'].includes(job.state));
  const paused = $derived(publishPaused(view));
  // The headline already names a wait, so the status row shows the state's progress instead. A
  // paused upload has none to show, so the row names what it's waiting on.
  const status = $derived(jobStatus(view, paused ? view.wait : undefined, uploadPct));
  const tooShortForShort = $derived(!!job.probe && !canCutShort(job.probe.durationSec));
  const current = $derived(stepIndex(job.state, reviewStep, job.failedState));
  const work = $derived(workCopy(view));

  // Reading `view` reruns this whenever a new view lands.
  $effect(() => {
    if (view) stepStartedAt = now = Date.now();
  });

  $effect(() => {
    const tick = working ? setInterval(() => (now = Date.now()), 1000) : undefined;
    return () => clearInterval(tick);
  });

  const signedOut = () => void goto(resolve('/'), { refreshAll: true });

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
        signedOut,
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
    if (!shortView || drivingShort === shortView.job.id) return;
    const id = shortView.job.id;
    drivingShort = id;
    try {
      await drive(shortView, {
        step: () => step(id, data.trace),
        stopped: () => stopped || shortView?.job.id !== id,
        onView: (next) => {
          if (stopped || shortView?.job.id !== id) return;
          showShort(next);
          shortMessage = next.job.error ?? '';
        },
        onError: (text) => {
          if (!stopped && shortView?.job.id === id) shortMessage = text;
        },
        signedOut,
      });
    } finally {
      if (drivingShort === id) drivingShort = null;
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
        room = 'release';
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

  /** Rooms stay mounted so their edits survive a trip away; a hidden one must not keep playing. */
  const enter = (next: typeof room) => {
    for (const video of document.querySelectorAll('video')) if (!video.paused) video.pause();
    room = next;
  };

  const makeShort = async () => {
    await actShort('short');
    if (shortView) enter('short');
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
      // A few looks for the landed object; past that, run() takes over with whatever state it reads.
      await pRetry(
        async () => {
          if (stopped) throw new AbortError(new Waiting('stopped'));
          view = await step(job.id, data.trace);
          if (view.job.state === 'AWAITING_UPLOAD') throw new Waiting('upload not landed');
        },
        { ...POLL_BACKOFF, retries: 4, shouldRetry: ({ error }) => error instanceof Waiting },
      ).catch((error: unknown) => {
        if (!(error instanceof Waiting)) throw error;
      });
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

<svelte:head><title>{job.songTitle} · Soundboard</title></svelte:head>

<ReleaseBar
  title={job.songTitle}
  step={current}
  label={room === 'short' ? 'Short' : room === 'bandcamp' ? 'Bandcamp' : undefined}
/>

<main class="step">
  {#if data.expired}
    <p class="notice" data-tone="warn" role="note">
      This video is gone from storage after 7 days. Its saved details stay here; upload it again
      from the home page to finish anything that needs the video.
    </p>
  {/if}

  {#if room !== 'release'}
    <button
      class="back"
      type="button"
      onclick={() => {
        enter('release');
        shortMessage = '';
      }}
    >
      Back to the release
    </button>
  {/if}

  {#if shortView}
    <div class="room" hidden={room !== 'short'}>
      <div class="intro">
        <h1>Is this the hook?</h1>
        <p class="help">
          A vertical cut from the video's strongest moment, with its own approval and upload.
        </p>
      </div>
      <Short
        view={shortView}
        src={shortSrc}
        busy={shortBusy}
        message={room === 'short' ? shortMessage : ''}
        serverErrors={shortErrors}
        approveTo={data.approveTo}
        expired={data.shortExpired && shortView.job.id === data.short?.job.id}
        onrecut={(cut) => actShort('recut', cut)}
        onapprove={(f) =>
          actShort('approve', {
            ...f,
            pickVersion: shortView?.pick?.version,
            channelId: data.approveTo?.channelId,
          })}
        onrerun={() => actShort('rerun')}
        ondiscard={() => actShort('discard')}
        onretry={() => actShort('retry')}
        onconfirm={(url) => actShort('confirm-upload', { url })}
      />
    </div>
  {/if}

  {#if room === 'bandcamp' && fields && view.pick}
    <div class="intro">
      <h1>Copy these into Bandcamp</h1>
      <p class="help">Bandcamp has no upload API for artists, so this is copy and paste.</p>
    </div>
    <Bandcamp
      jobId={job.id}
      songTitle={job.songTitle}
      pick={view.pick}
      tags={fields.tags}
      ondone={(d) => (bandcampDone = d)}
    />
  {/if}

  <div class="room" hidden={room !== 'release'}>
    {#if job.state === 'REVIEW' && fields && view.pick}
      {@const pick = view.pick}
      {#key pick.version}
        <Review
          {fields}
          {pick}
          candidates={job.hashtagCandidates ?? []}
          destination={data.approveTo}
          draft={draftKey(job.id, pick.version)}
          {busy}
          {serverErrors}
          bind:step={reviewStep}
          onapprove={async (f) => {
            const key = draftKey(job.id, pick.version);
            await act('approve', {
              ...f,
              pickVersion: pick.version,
              channelId: data.approveTo?.channelId,
            });
            // A failed approval keeps the job in review, and the edits with it.
            if (view.job.state !== 'REVIEW') clearDraft(key);
          }}
          onrerun={() => {
            // The new pick opens on its title, not the screen the re-run came from.
            reviewStep = 'title';
            act('rerun');
          }}
          ondiscard={() => act('discard')}
        />
      {/key}
    {:else if job.state === 'VERIFIED'}
      <div class="intro">
        <span class="chip" data-tone="ok">Verified · private</span>
        <h1>It's on your channel</h1>
        <p class="help">
          Read back from YouTube.
          {#if job.videoId}<a href="https://youtu.be/{job.videoId}" target="_blank" rel="noopener"
              >youtu.be/{job.videoId}</a
            >{/if}
          Private until you publish it there.
        </p>
      </div>
    {:else if job.state === 'FAILED'}
      <div class="intro">
        <h1>This step failed</h1>
        <p class="help">Everything before it is kept. Retry picks up at the step that failed.</p>
      </div>
      <div class="actions">
        <button class="btn danger" type="button" disabled={busy} onclick={() => act('discard')}
          >Discard</button
        >
        <button class="btn primary" type="button" disabled={busy} onclick={() => act('retry')}
          >Retry</button
        >
      </div>
    {:else if job.state === 'DISCARDED'}
      <div class="intro">
        <h1>This release was discarded</h1>
        <p class="help">Nothing more happens to it. Anything already on YouTube stays there.</p>
      </div>
    {:else}
      <div class="intro">
        <h1>{work.title}</h1>
        <p class="help">{work.body}</p>
      </div>
      <Monitor
        src={localUrl ?? data.playbackUrl}
        filename={job.filename}
        width={job.probe?.width}
        height={job.probe?.height}
      />
      <div class="panel">
        <Track {status} {model} {seconds} />
      </div>
      {#if !approved}
        <Heard tags={heardTags(view)} measurements={job.measurements} />
      {:else if job.finalFields}
        <p class="help">Uploading as <strong>{job.finalFields.title}</strong>, Private.</p>
      {/if}
      <UploadRecovery {view} {busy} onconfirm={(url) => act('confirm-upload', { url })} />
      {#if paused}
        <div class="actions">
          <button class="btn danger" type="button" disabled={busy} onclick={() => act('discard')}
            >Discard</button
          >
        </div>
      {/if}
    {/if}

    <!-- A Short outlives its video's upload: one already made stays reachable if that stops. -->
    {#if (approved && fields && view.pick) || shortView}
      <section class="offers" aria-labelledby="offers-heading">
        <h2 id="offers-heading">Up next, if you want</h2>
        {#if shortView}
          <button class="offer" type="button" onclick={() => enter('short')}>
            <span>
              <strong
                >{shortView.job.state === 'VERIFIED' ? 'Your Short' : 'Finish the Short'}</strong
              >
              <span class="help"
                >{shortView.job.state === 'VERIFIED'
                  ? 'Uploaded and verified.'
                  : 'Its own review and upload.'}</span
              >
            </span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        {:else if approved}
          <button
            class="offer"
            type="button"
            disabled={shortBusy || tooShortForShort}
            onclick={makeShort}
          >
            <span>
              <strong>Make a Short from the hook</strong>
              <span class="help"
                >{tooShortForShort
                  ? `A Short needs a video of at least ${SHORT_MIN_SEC} seconds.`
                  : 'A vertical cut of the strongest moment, with its own approval.'}</span
              >
            </span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        {/if}
        {#if approved && fields && view.pick}
          <button class="offer" type="button" onclick={() => enter('bandcamp')}>
            <span>
              <strong>Put it on Bandcamp</strong>
              <span class="help"
                >{bandcampDone
                  ? 'Every field copied.'
                  : 'Copy the drafted fields into Bandcamp.'}</span
              >
            </span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        {/if}
        {#if job.state === 'VERIFIED'}
          <a class="btn" href={resolve('/')}>I'm done for now</a>
        {/if}
        <p class="toast" aria-live="polite">{room === 'release' ? shortMessage : ''}</p>
      </section>
    {/if}
  </div>

  <p class="toast" aria-live="polite">{message}</p>
</main>

<style>
  /* The wrapper only hides a room; its children keep the page's column gap. */
  .room {
    display: contents;
  }

  .room[hidden] {
    display: none;
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 24px;
    width: 100%;
    max-width: calc(var(--measure-step) + 2 * var(--gutter));
    margin: 0 auto;
    padding: 32px var(--gutter) 64px;
  }

  .intro {
    display: grid;
    gap: 8px;
    justify-items: start;
  }

  .intro .help {
    font-size: 16px;
  }

  .back {
    align-self: flex-start;
    min-height: 44px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--action);
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 12px;
  }

  .offers {
    display: grid;
    gap: 10px;
    justify-items: stretch;
  }

  .offers > .btn {
    justify-self: start;
  }

  .offer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    min-height: 64px;
    padding: 16px 20px;
    border: 1px solid var(--edge);
    border-radius: 12px;
    background: var(--panel);
    color: var(--ink);
    text-align: left;
    cursor: pointer;
    transition: border-color var(--motion);
  }

  .offer:not(:disabled):hover {
    border-color: var(--action);
  }

  .offer:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .offer > span {
    display: grid;
    gap: 2px;
  }

  .offer strong {
    font-weight: 600;
  }

  .offer svg {
    flex: none;
    width: 20px;
    height: 20px;
    fill: none;
    stroke: var(--action);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>

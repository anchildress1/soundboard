<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { action, ApiError, step, uploadToGcs, type ActionName } from '$lib/api';
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
  import { heardTags, jobStatus, lastModelSeconds } from '$lib/status';
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

  type Tab = 'video' | 'short';
  const TABS: { id: Tab; label: string }[] = [
    { id: 'video', label: 'Video' },
    { id: 'short', label: 'Short' },
  ];
  let tab = $state<Tab>('video');

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
  const tabbed = $derived(SHORT_SOURCE_STATES.includes(job.state) || shortView !== null);

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

  /** Signed URLs change on every response; the player only reloads for a new render. */
  function showShort(next: JobView) {
    const renders = shortView?.job.short?.renders;
    shortView = next;
    if (next.playbackUrl && (next.job.short?.renders !== renders || !shortSrc)) {
      shortSrc = next.playbackUrl;
    }
  }

  async function runShort() {
    if (drivingShort || !shortView) return;
    drivingShort = true;
    const id = shortView.job.id;
    try {
      await drive(shortView, {
        step: () => step(id, data.trace),
        sleep,
        stopped: () => stopped || shortView?.job.id !== id,
        onView: (next) => {
          showShort(next);
          shortMessage = next.job.error ?? '';
        },
        onError: (text) => (shortMessage = text),
      });
    } finally {
      drivingShort = false;
    }
  }

  async function actShort(name: ActionName, body: unknown = {}) {
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
  }

  function selectTab(next: Tab) {
    tab = next;
    document.getElementById(`tab-${next}`)?.focus();
  }

  /** Arrow keys, Home, and End move between tabs (WAI-ARIA tabs pattern, automatic activation). */
  function tabKey(event: KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === tab);
    const moves: Record<string, number> = {
      ArrowRight: (i + 1) % TABS.length,
      ArrowLeft: (i - 1 + TABS.length) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    };
    const to = moves[event.key];
    if (to === undefined) return;
    event.preventDefault();
    selectTab(TABS[to]!.id);
  }

  async function act(name: 'approve' | 'rerun' | 'discard' | 'retry', body: unknown = {}) {
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
  }

  onMount(async () => {
    if (shortView && DRIVEN_STATES.includes(shortView.job.state)) void runShort();
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
  {#if tabbed}
    <div class="tabs" role="tablist" aria-label="Review">
      {#each TABS as t (t.id)}
        <button
          type="button"
          role="tab"
          id="tab-{t.id}"
          aria-selected={tab === t.id}
          aria-controls="panel-{t.id}"
          tabindex={tab === t.id ? 0 : -1}
          onclick={() => (tab = t.id)}
          onkeydown={tabKey}>{t.label}</button
        >
      {/each}
    </div>
  {/if}

  <div
    class="panel"
    id="panel-video"
    role={tabbed ? 'tabpanel' : undefined}
    aria-labelledby={tabbed ? 'tab-video' : undefined}
    hidden={tabbed && tab !== 'video'}
  >
    <section class="tape" aria-label="The video">
      <Monitor
        src={localUrl ?? data.playbackUrl}
        filename={job.filename}
        height={job.probe?.height}
      />
      <Track {status} {model} />
      {#if job.state === 'VERIFIED' && job.videoId}
        <p class="verified">
          Verified · private · <a
            href="https://youtu.be/{job.videoId}"
            target="_blank"
            rel="noopener">youtu.be/{job.videoId}</a
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
            onapprove={(f) => act('approve', { ...f, pickVersion: view.pick?.version })}
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
        <Payload fields={job.payload} />
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
  </div>

  {#if tabbed}
    <div id="panel-short" role="tabpanel" aria-labelledby="tab-short" hidden={tab !== 'short'}>
      {#if shortView}
        <Short
          view={shortView}
          src={shortSrc}
          busy={shortBusy}
          message={shortMessage}
          serverErrors={shortErrors}
          onrecut={(cut) => actShort('recut', cut)}
          onapprove={(f) => actShort('approve', { ...f, pickVersion: shortView?.pick?.version })}
          onrerun={() => actShort('rerun')}
          ondiscard={() => actShort('discard')}
          onretry={() => actShort('retry')}
        />
      {:else}
        <section class="placeholder make" aria-labelledby="make-short-heading">
          <h2 id="make-short-heading">Short</h2>
          <p>
            A vertical cut of this video's hook for YouTube Shorts. The model picks the hook; ffmpeg
            cuts it and fits it to 9:16. It reuses this video's title, description, and tags.
          </p>
          <button
            class="btn primary"
            type="button"
            disabled={shortBusy}
            onclick={() => actShort('short')}>Make a Short</button
          >
          <p class="toast" aria-live="polite">{shortMessage}</p>
        </section>
      {/if}
    </div>
  {/if}
</main>

<style>
  main {
    display: grid;
    gap: 16px;
  }

  .panel {
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
    gap: 20px;
    align-items: start;
  }

  .panel[hidden] {
    display: none;
  }

  @media (max-width: 820px) {
    .panel {
      grid-template-columns: 1fr;
    }
  }

  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--line);
  }

  [role='tab'] {
    background: transparent;
    color: var(--muted);
    border: 0;
    border-bottom: 3px solid transparent;
    padding: 10px 16px;
    min-height: 44px;
    font: 700 13px/1 var(--display);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    cursor: pointer;
  }

  [role='tab'][aria-selected='true'] {
    color: var(--ink);
    border-bottom-color: var(--magenta);
  }

  [role='tab']:focus-visible {
    outline: 2px solid var(--magenta);
    outline-offset: -2px;
  }

  .make {
    display: grid;
    gap: 12px;
    justify-items: start;
    max-width: 60ch;
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
  .notes {
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

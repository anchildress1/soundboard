<script lang="ts">
  import pRetry from 'p-retry';
  import { onDestroy, onMount } from 'svelte';
  import { ApiError, SessionTimeout, UploadConflict, uploadSession } from '#lib/api.js';
  import { fingerprint } from '#lib/fingerprint.js';
  import { UPLOAD_BACKOFF } from '#lib/retry.js';
  import { jobStatus, UPLOAD_NOTICE, type UploadShown } from '#lib/status.js';
  import type { JobView, UploadSaved } from '#lib/types.js';
  import {
    acquire,
    ALREADY_DONE,
    DISCARDED,
    holder,
    MOVED,
    newOpId,
    REPLACED,
    start,
    stop,
    uploads,
    waitFor,
    type Upload,
  } from '#lib/upload.js';
  import Monitor from './Monitor.svelte';
  import Track from './Track.svelte';

  let {
    view,
    model,
    saved,
    generation,
    onlanded,
    onrefresh,
  }: {
    view: JobView;
    model: string;
    /** What GCS had when the page loaded; null when it didn't say. */
    saved: UploadSaved | null;
    /** The upload generation the page load saw. */
    generation: number;
    /** The last byte landed: the page moves the job on. */
    onlanded: () => void;
    /** Reloads the page's data, after another tab or device changed the job. */
    onrefresh: () => Promise<void>;
  } = $props();

  const READ_MS = 15_000;

  const job = $derived(view.job);
  const entry = $derived<Upload | undefined>($uploads[job.id]);
  /** What this page shows while no upload runs here: set by a pick, the lock or a 409. */
  let local = $state<'other-tab' | 'unreadable' | 'replaced' | 'moved' | null>(null);
  let reading = $state(false);
  let error = $state('');
  let objectUrl = $state<string | null>(null);
  let duration = $state(0);
  let seen = $state(0);
  let landed = false;
  let refreshed = false;
  const left = new AbortController();

  // Generations only grow, so the largest one this tab saw is the newest.
  const observed = $derived(Math.max(generation, entry?.generation ?? 0, seen));
  const active = $derived(
    entry?.state === 'sending' || entry?.state === 'paused' || entry?.state === 'away',
  );
  const stopped = $derived(entry?.state === 'stopped' ? (entry.error ?? '') : '');

  const shown = $derived.by((): UploadShown => {
    if (entry?.state === 'sending' || entry?.state === 'done') {
      return { state: 'sending', saved: entry.saved, total: entry.size };
    }
    if (entry?.state === 'paused' && entry.reason) {
      return { state: 'paused', reason: entry.reason, saved: entry.saved, total: entry.size };
    }
    if (entry?.state === 'away') return { state: 'away', saved: entry.saved, total: entry.size };
    if (local) return { state: local };
    if (entry?.state === 'replaced' || entry?.state === 'moved') return { state: entry.state };
    return { state: 'pick', saved: saved?.saved ?? null, total: saved?.total ?? 0 };
  });
  const status = $derived(jobStatus(view, undefined, shown));
  const picker = $derived(!active && !reading && shown.state !== 'other-tab');
  const shownError = $derived(
    error || (stopped === DISCARDED || stopped === ALREADY_DONE ? '' : stopped),
  );

  const land = () => {
    if (landed) return;
    landed = true;
    onlanded();
  };

  const refresh = async () => {
    if (refreshed) return;
    refreshed = true;
    await onrefresh();
  };

  const show = (file: File | null) => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = file ? URL.createObjectURL(file) : null;
    duration = 0;
  };

  const waitTurn = () => {
    local = 'other-tab';
    waitFor(job.id, left.signal, () => {
      local = null;
      // The page reloads its data; a landed upload then moves the job on.
      void onrefresh().then(() => {
        if (saved?.done) land();
      });
    });
  };

  $effect(() => {
    if (entry?.state === 'done' || stopped === ALREADY_DONE) land();
    if (stopped === DISCARDED) void refresh();
  });

  let measuring: ((seconds: number | null) => void) | null = null;

  $effect(() => {
    if (Number.isFinite(duration) && duration > 0) measuring?.(duration);
  });

  /** The picked file's duration from the Monitor; null when it can't play or 15 s pass. */
  const measure = () =>
    new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => measuring?.(null), READ_MS);
      measuring = (seconds) => {
        clearTimeout(timer);
        measuring = null;
        resolve(seconds);
      };
    });

  const retryable = (failure: unknown) =>
    failure instanceof SessionTimeout ||
    failure instanceof TypeError ||
    (failure instanceof ApiError && !(failure instanceof UploadConflict) && failure.status >= 500);

  const unreadable = () => {
    show(null);
    local = 'unreadable';
  };

  /** Reads the file in full before taking the lock, so a bad file never takes it (research R8). */
  async function read(file: File): Promise<{ durationSec: number; print: string } | null> {
    show(file);
    const durationSec = await measure();
    if (durationSec === null) return null;
    const print = await fingerprint(file).catch(() => null);
    return print === null ? null : { durationSec, print };
  }

  async function pick(file: File) {
    error = '';
    local = null;
    reading = true;
    try {
      const got = await read(file);
      if (!got) return unreadable();
      if (!(await acquire(job.id))) return waitTurn();
      await claim(file, got.durationSec, got.print);
    } finally {
      reading = false;
    }
  }

  async function claim(file: File, durationSec: number, print: string) {
    const body = {
      op: 'pick' as const,
      opId: newOpId(),
      generation: observed,
      size: file.size,
      fingerprint: print,
      filename: file.name,
      contentType: file.type || 'video/mp4',
      durationSec,
    };
    try {
      const reply = await pRetry(() => uploadSession(job.id, body), {
        ...UPLOAD_BACKOFF,
        retries: Number.POSITIVE_INFINITY,
        signal: left.signal,
        shouldRetry: ({ error: failure }) => retryable(failure),
      });
      seen = reply.generation;
      start(job.id, {
        file,
        sessionUri: reply.sessionUri,
        generation: reply.generation,
        fingerprint: print,
        notice: reply.restarted ? 'new-video' : null,
      });
    } catch (failure) {
      // No upload started under this pick: give the lock back.
      stop(job.id);
      if (failure instanceof UploadConflict) seen = Math.max(seen, failure.generation ?? 0);
      const { message } = failure as Error;
      if (message === ALREADY_DONE) land();
      else if (message === DISCARDED) void refresh();
      else if (message === REPLACED) local = 'replaced';
      else if (message === MOVED) local = 'moved';
      else error = message;
    }
  }

  const picked = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void pick(file);
  };

  onMount(() => {
    if (entry) {
      show(entry.file);
      return;
    }
    if (saved?.done) {
      land();
      return;
    }
    void holder(job.id).then((elsewhere) => {
      if (elsewhere) waitTurn();
    });
  });

  onDestroy(() => {
    left.abort();
    measuring?.(null);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    // A running upload keeps going across the app; anything else lets the lock go.
    if (!active) stop(job.id);
  });
</script>

<Monitor
  src={objectUrl}
  filename={entry?.file.name ?? job.filename}
  bind:duration
  onerror={() => measuring?.(null)}
/>
<div class="panel">
  <Track {status} {model} />
</div>
{#if entry?.state === 'sending' && entry.notice}
  <p class="notice" data-tone="info" role="note">{UPLOAD_NOTICE[entry.notice]}</p>
{/if}
{#if shownError}
  <p class="toast err" role="alert">{shownError}</p>
{/if}
{#if picker}
  <div class="field">
    <label for="repick-{job.id}">Pick the video</label>
    <input id="repick-{job.id}" type="file" accept="video/*" onchange={picked} />
  </div>
{/if}

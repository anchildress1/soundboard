<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { jobStatus, UPLOAD_NOTICE, type UploadShown } from '#lib/status.js';
  import type { JobView, UploadSaved } from '#lib/types.js';
  import { uploads, type Upload } from '#lib/upload.js';
  import Monitor from './Monitor.svelte';
  import Track from './Track.svelte';

  let {
    view,
    model,
    saved,
    onlanded,
  }: {
    view: JobView;
    model: string;
    /** What GCS had when the page loaded; null when it didn't say. */
    saved: UploadSaved | null;
    /** The last byte landed: the page moves the job on. */
    onlanded: () => void;
  } = $props();

  const job = $derived(view.job);
  const entry = $derived<Upload | undefined>($uploads[job.id]);
  let objectUrl = $state<string | null>(null);
  let landed = false;

  const shown = $derived.by((): UploadShown => {
    if (entry?.state === 'sending' || entry?.state === 'done') {
      return { state: 'sending', saved: entry.saved, total: entry.size };
    }
    if (entry?.state === 'paused' && entry.reason) {
      return { state: 'paused', reason: entry.reason, saved: entry.saved, total: entry.size };
    }
    if (entry?.state === 'away' || entry?.state === 'replaced' || entry?.state === 'moved') {
      return { state: entry.state };
    }
    return { state: 'pick', saved: saved?.saved ?? null, total: saved?.total ?? 0 };
  });
  const status = $derived(jobStatus(view, undefined, shown));

  const land = () => {
    if (landed) return;
    landed = true;
    onlanded();
  };

  $effect(() => {
    if (entry?.state === 'done') land();
  });

  onMount(() => {
    if (entry) objectUrl = URL.createObjectURL(entry.file);
    else if (saved?.done) land();
  });

  onDestroy(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
</script>

<Monitor src={objectUrl} filename={job.filename} />
<div class="panel">
  <Track {status} {model} />
</div>
{#if entry?.state === 'sending' && entry.notice}
  <p class="notice" data-tone="info" role="note">{UPLOAD_NOTICE[entry.notice]}</p>
{/if}
{#if entry?.state === 'stopped' && entry.error}
  <p class="toast err" role="alert">{entry.error}</p>
{/if}

<script lang="ts">
  import { resolve } from '$app/paths';
  import { publishPaused } from '#lib/status.js';
  import type { JobView } from '#lib/types.js';

  let {
    view,
    busy,
    onconfirm,
  }: {
    view: JobView;
    busy: boolean;
    onconfirm: (url: string) => void;
  } = $props();
  let pastedUrl = $state('');
  const id = $derived(`upload-recovery-${view.job.id}`);
</script>

{#if publishPaused(view) && view.wait === 'reconnect YouTube'}
  <section class="paused" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Upload paused</h2>
    <p>
      YouTube access is lost. <a href={resolve('connections')}>Reconnect on Connections</a>
      to resume, or discard the job.
    </p>
  </section>
{:else if publishPaused(view) && view.wait === 'upload outcome unknown' && view.job.destination}
  <section class="paused" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Upload outcome unknown</h2>
    <p>
      YouTube lost the upload session after its last bytes may have gone out, so the video may be
      there. Check your uploads; if it is, paste its link. Soundboard never uploads it again on its
      own.
    </p>
    <a
      href="https://studio.youtube.com/channel/{view.job.destination.channelId}/videos/upload"
      target="_blank"
      rel="noopener">Open YouTube Studio uploads</a
    >
    <form
      onsubmit={(event) => {
        event.preventDefault();
        if (!busy && pastedUrl.trim()) onconfirm(pastedUrl);
      }}
    >
      <div class="field">
        <label for={`${id}-url`}>Video link</label>
        <input
          id={`${id}-url`}
          type="url"
          required
          placeholder="https://youtu.be/…"
          bind:value={pastedUrl}
          disabled={busy}
        />
      </div>
      <button class="btn primary" type="submit" disabled={busy || !pastedUrl.trim()}>
        Confirm video
      </button>
    </form>
  </section>
{/if}

<style>
  .paused {
    display: grid;
    gap: 10px;
    justify-items: start;
    padding: 12px 14px;
    border: 1px solid var(--yellow);
    border-left-width: 4px;
    background: color-mix(in srgb, var(--yellow) 8%, var(--panel));
  }

  h2 {
    margin: 0 0 6px;
    font: 900 12px/1.2 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--yellow);
  }

  p {
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
  }

  form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 10px;
    width: 100%;
  }
</style>

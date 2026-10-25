<script lang="ts">
  import { timecode } from '#lib/format.js';
  import type { FieldErrors } from '#lib/metadata.js';
  import { cutErrors, lengthBounds, tenth } from '#lib/short.js';
  import { jobStatus, modelLabel, modelSeconds, publishPaused } from '#lib/status.js';
  import type { Destination, JobView, PickFields, Reframe } from '#lib/types.js';
  import Label from './Label.svelte';
  import Monitor from './Monitor.svelte';
  import Track from './Track.svelte';
  import UploadRecovery from './UploadRecovery.svelte';

  type Cut = { startSec: number; lengthSec: number; reframe: Reframe };
  type Fields = { title: string; description: string; tags: string[] };

  let {
    view,
    src = null,
    busy = false,
    message = '',
    serverErrors = {},
    approveTo,
    expired = false,
    onrecut,
    onapprove,
    onrerun,
    ondiscard,
    onretry,
    onconfirm,
  }: {
    view: JobView;
    src?: string | null;
    busy?: boolean;
    message?: string;
    serverErrors?: FieldErrors;
    /** The owner's connected channel, shown beside Approve until approval pins one. */
    approveTo: Destination | null;
    /** Storage dropped the media this Short's remaining work needs. */
    expired?: boolean;
    onrecut: (cut: Cut) => void;
    onapprove: (fields: Fields) => void;
    onrerun: () => void;
    ondiscard: () => void;
    onretry: () => void;
    onconfirm: (url: string) => void;
  } = $props();

  const job = $derived(view.job);
  const short = $derived(job.short!);
  const hook = $derived(short.hook);
  const status = $derived(jobStatus(view, view.wait));
  const seconds = $derived(modelSeconds(view));
  const model = $derived(modelLabel(view));
  const editable = $derived(job.state === 'REVIEW');
  const done = $derived(['PUBLISHING', 'CLAIMED_COMPLETE', 'VERIFIED'].includes(job.state));
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
  const bounds = $derived(lengthBounds(short.sourceDurationSec));

  // Overridable: the owner's edits stick until a new hook or render resets them.
  let startSec = $derived(hook?.startSec ?? 0);
  let lengthSec = $derived(hook?.lengthSec ?? bounds.min);
  let reframe = $derived<Reframe>(short.reframe);

  const cut = $derived({ startSec: tenth(Number(startSec)), lengthSec: tenth(Number(lengthSec)) });
  const errors = $derived(cutErrors(cut, short.sourceDurationSec));
  const changed = $derived(
    hook !== null &&
      (cut.startSec !== hook.startSec ||
        cut.lengthSec !== hook.lengthSec ||
        reframe !== short.reframe),
  );
  const canRecut = $derived(editable && changed && Object.keys(errors).length === 0 && !busy);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (canRecut) onrecut({ ...cut, reframe });
  };
</script>

<div class="short">
  {#if expired}
    <p class="notice" data-tone="warn" role="note">
      This Short's video is gone from storage after 7 days. Its saved details stay here; upload the
      video again from the home page to finish anything that needs it.
    </p>
  {/if}
  {#if job.state === 'VERIFIED' && job.videoId}
    <p class="notice" data-tone="ok">
      <span
        >Short uploaded to YouTube · private ·
        <a href="https://youtu.be/{job.videoId}" target="_blank" rel="noopener"
          >youtu.be/{job.videoId}</a
        ></span
      >
    </p>
  {/if}
  <section class="tape" aria-label="The Short">
    <Monitor
      {src}
      filename={job.filename}
      width={job.probe?.width}
      height={job.probe?.height}
      vertical
    />
    <Track {status} {model} {seconds} />

    {#if hook}
      <section class="cut panel" aria-labelledby="short-cut-heading">
        <h2 id="short-cut-heading">Cut</h2>
        <p class="range">
          {timecode(hook.startSec)} – {timecode(hook.startSec + hook.lengthSec)} · {hook.lengthSec}s
        </p>
        {#if hook.reason}<p class="why"><span>Why this hook</span> {hook.reason}</p>{/if}

        <form onsubmit={submit} novalidate>
          <div class="row">
            <div class="field" class:err={errors.startSec}>
              <label for="short-start">Start <span>seconds</span></label>
              <input
                id="short-start"
                type="number"
                inputmode="decimal"
                step="0.1"
                min="0"
                bind:value={startSec}
                disabled={!editable}
                aria-invalid={errors.startSec ? 'true' : undefined}
                aria-describedby={errors.startSec ? 'short-start-msg' : undefined}
              />
              {#if errors.startSec}<span class="msg" id="short-start-msg">{errors.startSec}</span
                >{/if}
            </div>
            <div class="field" class:err={errors.lengthSec}>
              <label for="short-length">Length <span>{bounds.min}–{bounds.max} s</span></label>
              <input
                id="short-length"
                type="number"
                inputmode="decimal"
                step="0.1"
                min={bounds.min}
                max={bounds.max}
                bind:value={lengthSec}
                disabled={!editable}
                aria-invalid={errors.lengthSec ? 'true' : undefined}
                aria-describedby={errors.lengthSec ? 'short-length-msg' : undefined}
              />
              {#if errors.lengthSec}<span class="msg" id="short-length-msg">{errors.lengthSec}</span
                >{/if}
            </div>
          </div>
          <fieldset disabled={!editable}>
            <legend>Fit to 9:16</legend>
            <label
              ><input type="radio" name="reframe" value="blur" bind:group={reframe} /> Blur fill</label
            >
            <label
              ><input type="radio" name="reframe" value="crop" bind:group={reframe} /> Center crop</label
            >
          </fieldset>
          {#if editable}
            <button class="btn" type="submit" disabled={!canRecut}>Re-cut</button>
          {/if}
        </form>
      </section>
    {/if}
  </section>

  {#if fields}
    {#key job.id}
      <Label
        {fields}
        candidates={job.hashtagCandidates ?? []}
        {editable}
        {busy}
        {done}
        discardable={publishPaused(view)}
        {serverErrors}
        destination={job.destination ?? (editable ? approveTo : null)}
        uploaded={job.videoId !== null}
        idPrefix="short-"
        heading="YouTube Short"
        rerunLabel="Re-pick hook"
        {onapprove}
        {onrerun}
        {ondiscard}
      />
      <UploadRecovery {view} {busy} {onconfirm} />
    {/key}
  {/if}
  {#if job.state === 'FAILED'}
    <div class="actions">
      <button class="btn danger" type="button" disabled={busy} onclick={ondiscard}>Discard</button>
      <button class="btn primary" type="button" disabled={busy} onclick={onretry}>Retry</button>
    </div>
  {/if}
  <p class="toast" aria-live="polite">{message}</p>
</div>

<style>
  .short,
  .tape {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
  }

  .cut {
    display: grid;
    gap: 12px;
  }

  h2 {
    font: 600 16px/1.4 var(--font-body);
  }

  .range {
    font-variant-numeric: tabular-nums;
  }

  .why {
    font-size: 14px;
    color: var(--muted);
  }

  .why span {
    margin-right: 6px;
    font-weight: 600;
    color: var(--ink);
  }

  form {
    display: grid;
    gap: 16px;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend {
    margin-bottom: 8px;
    padding: 0;
    font-size: 14px;
    font-weight: 600;
  }

  /* Segmented choice: the whole pill is the target. */
  fieldset label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--edge);
    border-radius: var(--radius-control);
    cursor: pointer;
  }

  fieldset label:has(input:checked) {
    border-color: var(--action);
    color: var(--action);
  }

  fieldset label:has(input:focus-visible) {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  input[type='radio'] {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--action);
  }

  form .btn {
    justify-self: start;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 12px;
  }
</style>

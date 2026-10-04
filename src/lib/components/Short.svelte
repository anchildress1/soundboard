<script lang="ts">
  import { timecode } from '$lib/format';
  import type { FieldErrors } from '$lib/metadata';
  import { cutErrors, lengthBounds, tenth } from '$lib/short';
  import { jobStatus, modelSeconds } from '$lib/status';
  import type { JobView, PickFields, Reframe } from '$lib/types';
  import Label from './Label.svelte';
  import Monitor from './Monitor.svelte';
  import Payload from './Payload.svelte';
  import Track from './Track.svelte';

  type Cut = { startSec: number; lengthSec: number; reframe: Reframe };
  type Fields = { title: string; description: string; tags: string[] };

  let {
    view,
    src = null,
    busy = false,
    message = '',
    serverErrors = {},
    onrecut,
    onapprove,
    onrerun,
    ondiscard,
    onretry,
  }: {
    view: JobView;
    src?: string | null;
    busy?: boolean;
    message?: string;
    serverErrors?: FieldErrors;
    onrecut: (cut: Cut) => void;
    onapprove: (fields: Fields) => void;
    onrerun: () => void;
    ondiscard: () => void;
    onretry: () => void;
  } = $props();

  const job = $derived(view.job);
  const short = $derived(job.short!);
  const hook = $derived(short.hook);
  const status = $derived(jobStatus(view, view.wait));
  const seconds = $derived(modelSeconds(view));
  const model = $derived(seconds ? `gemma-4-12b-it · ${seconds}s` : 'gemma-4-12b-it');
  const editable = $derived(job.state === 'REVIEW');
  const done = $derived(['PUBLISHING', 'CLAIMED_COMPLETE', 'VERIFIED'].includes(job.state));
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
  const bounds = $derived(lengthBounds(short.sourceDurationSec));

  // Overridable: the artist's edits stick until a new hook or render resets them.
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

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (canRecut) onrecut({ ...cut, reframe });
  }
</script>

<div class="short">
  {#if job.state === 'VERIFIED' && job.videoId}
    <p class="uploaded">
      <span class="check" aria-hidden="true">✓</span>
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
    <Track {status} {model} />

    {#if hook}
      <section class="cut" aria-labelledby="short-cut-heading">
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
            <button class="btn ghost" type="submit" disabled={!canRecut}>Re-cut</button>
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
        {serverErrors}
        idPrefix="short-"
        heading="YouTube Short"
        rerunLabel="Re-pick hook"
        {onapprove}
        {onrerun}
        {ondiscard}
      />
    {/key}
  {/if}
  {#if job.state === 'PAYLOAD' && job.payload}
    <Payload fields={job.payload} />
  {/if}
  {#if job.state === 'FAILED'}
    <div class="actions">
      <button class="btn ghost" type="button" disabled={busy} onclick={ondiscard}>Discard</button>
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

  .cut {
    background: var(--panel);
    padding: 12px 14px;
    display: grid;
    gap: 10px;
  }

  h2 {
    margin: 0;
    font: 900 12px/1.2 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--orange);
  }

  .range {
    margin: 0;
    font: 500 13px/1.4 var(--mono);
    color: var(--ink);
  }

  .why {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
  }

  .why span {
    font: 600 12px/1 var(--sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-right: 6px;
  }

  form {
    display: grid;
    gap: 12px;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  fieldset {
    border: 1px solid var(--line);
    margin: 0;
    padding: 8px 12px 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
  }

  legend {
    padding: 0 4px;
    font: 600 12px/1 var(--sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  fieldset label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    min-height: 44px;
  }

  input[type='radio'] {
    accent-color: var(--magenta);
    width: 18px;
    height: 18px;
  }

  input[type='radio']:focus-visible {
    outline: 2px solid var(--magenta);
    outline-offset: 2px;
  }

  form .btn {
    justify-self: end;
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

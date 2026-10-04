<script lang="ts">
  import { onDestroy } from 'svelte';
  import { approveBrand, discardBrandProposal, proposeBrand } from '$lib/api';
  import {
    BRAND_THUMBNAILS,
    BRAND_VIDEOS,
    guideError,
    RULE_MAX,
    RULES_MAX,
    splitRules,
    STATEMENT_MAX,
    type StoredBrand,
  } from '$lib/brand';
  import { sleep, WAIT_MS } from '$lib/driver';
  import type { Wait } from '$lib/types';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const LISTS = [
    { key: 'keep', label: 'Keep' },
    { key: 'fix', label: 'Fix' },
    { key: 'drop', label: 'Drop' },
  ] as const;
  type Draft = { statement: string; keep: string; fix: string; drop: string };

  const toDraft = (guide: StoredBrand | null): Draft | null =>
    guide
      ? {
          statement: guide.statement,
          keep: guide.keep.join('\n'),
          fix: guide.fix.join('\n'),
          drop: guide.drop.join('\n'),
        }
      : null;

  // svelte-ignore state_referenced_locally
  let approved = $state<StoredBrand | null>(data.approved);
  // svelte-ignore state_referenced_locally
  let draft = $state<Draft | null>(toDraft(data.proposal));
  // svelte-ignore state_referenced_locally
  let proposedAt = $state<number | null>(data.proposal?.createdAt ?? null);
  let wait = $state<Wait | null>(null);
  let busy = $state(false);
  let message = $state('');
  let stopped = false;

  const guide = $derived(
    draft
      ? {
          statement: draft.statement.trim(),
          keep: splitRules(draft.keep),
          fix: splitRules(draft.fix),
          drop: splitRules(draft.drop),
        }
      : null,
  );
  const problem = $derived(guide ? guideError(guide) : null);
  const proposing = $derived(wait ?? 'Reading uploads');

  /** A loading or busy model answers with a wait at once; keep asking until it takes the call. */
  async function propose() {
    busy = true;
    message = '';
    try {
      while (!stopped) {
        const result = await proposeBrand();
        if ('proposal' in result) {
          draft = toDraft(result.proposal);
          proposedAt = result.proposal.createdAt;
          return;
        }
        wait = result.wait;
        await sleep(WAIT_MS[result.wait]);
      }
    } catch (error) {
      // A failed model call is not retried on its own: each try holds the GPU for a full call.
      message = error instanceof Error ? error.message : 'Proposal failed';
    } finally {
      wait = null;
      busy = false;
    }
  }

  async function approve(event: SubmitEvent) {
    event.preventDefault();
    if (!guide || problem || proposedAt === null) return;
    busy = true;
    message = '';
    try {
      approved = (await approveBrand(guide, proposedAt)).approved;
      draft = null;
    } catch (error) {
      message = error instanceof Error ? error.message : 'Approval failed';
    } finally {
      busy = false;
    }
  }

  async function discard() {
    busy = true;
    message = '';
    try {
      await discardBrandProposal();
      draft = null;
    } catch (error) {
      message = error instanceof Error ? error.message : 'Discard failed';
    } finally {
      busy = false;
    }
  }

  onDestroy(() => (stopped = true));
</script>

<svelte:head><title>Brand guide · Soundboard</title></svelte:head>

<main>
  <section class="current" aria-labelledby="current">
    <h2 id="current">Approved guide <span>smart pick follows this</span></h2>
    {#if approved}
      <p class="statement">{approved.statement}</p>
      {#each LISTS as list (list.key)}
        {#if approved[list.key].length > 0}
          <h3>{list.label}</h3>
          <ul>
            {#each approved[list.key] as rule, i (i)}<li>{rule}</li>{/each}
          </ul>
        {/if}
      {/each}
      <p class="meta">
        From {approved.basedOn.length} uploads · approved {new Date(
          approved.approvedAt ?? approved.createdAt,
        ).toLocaleDateString()}
      </p>
    {:else}
      <p class="note">None yet. Smart pick follows the recent uploads until one is approved.</p>
    {/if}
  </section>

  {#if draft}
    <form class="label" onsubmit={approve} aria-label="Proposed guide">
      <h2>Proposal <span>edit, then approve</span></h2>
      <div class="field">
        <label for="statement"
          >Statement <span>{draft.statement.length}/{STATEMENT_MAX}</span></label
        >
        <textarea id="statement" rows="4" bind:value={draft.statement} disabled={busy}></textarea>
      </div>
      {#each LISTS as list (list.key)}
        <div class="field">
          <label for={list.key}
            >{list.label}
            <span>one rule per line · up to {RULES_MAX} · {RULE_MAX} chars each</span></label
          >
          <textarea id={list.key} rows="4" bind:value={draft[list.key]} disabled={busy}></textarea>
        </div>
      {/each}
      <div class="actions">
        <button class="btn ghost" type="button" disabled={busy} onclick={discard}>Discard</button>
        <button class="btn ghost" type="button" disabled={busy} onclick={propose}
          >{busy ? proposing : 'Propose again'}</button
        >
        <button class="btn primary" type="submit" disabled={busy || Boolean(problem)}
          >Approve</button
        >
      </div>
      <p class="toast" aria-live="polite">{message || problem || ''}</p>
    </form>
  {:else}
    <div class="label">
      <h2>Proposal</h2>
      <p class="note">
        Reads the latest {BRAND_VIDEOS} uploads and {BRAND_THUMBNAILS} thumbnails, then proposes a statement
        with keep, fix, and drop rules.
      </p>
      <div class="actions">
        <button class="btn primary" type="button" disabled={busy} onclick={propose}
          >{busy ? proposing : 'Propose'}</button
        >
      </div>
      <p class="toast" aria-live="polite">{message}</p>
    </div>
  {/if}
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

  .current,
  .label {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }

  h2,
  h3 {
    margin: 0;
    font: 900 12px/1 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--magenta);
  }

  h3 {
    color: var(--ink);
  }

  h2 span {
    font: 500 11px/1 var(--mono);
    letter-spacing: 0;
    text-transform: none;
    color: var(--muted);
    margin-left: 6px;
  }

  .statement {
    margin: 0;
    line-height: 1.5;
  }

  ul {
    margin: 0;
    padding-left: 18px;
    font-size: 14px;
    line-height: 1.5;
  }

  .note,
  .meta {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
  }

  .meta {
    font-family: var(--mono);
    font-size: 11px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
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

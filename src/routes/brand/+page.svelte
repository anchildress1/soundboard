<script lang="ts">
  import { onDestroy } from 'svelte';
  import { resolve } from '$app/paths';
  import { approveBrand, discardBrandProposal, proposeBrand } from '#lib/api.js';
  import {
    BRAND_THUMBNAILS,
    BRAND_VIDEOS,
    guideError,
    RULE_MAX,
    RULES_MAX,
    splitRules,
    STATEMENT_MAX,
    type StoredBrand,
  } from '#lib/brand.js';
  import pRetry, { AbortError } from 'p-retry';
  import { POLL_BACKOFF, Waiting } from '#lib/retry.js';
  import { WAIT_TEXT } from '#lib/status.js';
  import type { Wait } from '#lib/types.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const LISTS = [
    { key: 'keep', label: 'Keep', tone: 'ok' },
    { key: 'fix', label: 'Fix', tone: 'warn' },
    { key: 'drop', label: 'Drop', tone: 'err' },
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
  const proposing = $derived(wait ? WAIT_TEXT[wait] : 'Reading uploads');

  /** A busy model answers with a wait at once; keep asking until it takes the call. */
  const propose = async () => {
    busy = true;
    message = '';
    try {
      const proposal = await pRetry(
        async () => {
          if (stopped) throw new AbortError(new Waiting('stopped'));
          const result = await proposeBrand();
          if ('proposal' in result) return result.proposal;
          // Asking again can't help until the quota resets at midnight Pacific.
          if (result.wait === 'model quota spent') throw new AbortError(result.wait);
          wait = result.wait;
          throw new Waiting(result.wait);
        },
        {
          ...POLL_BACKOFF,
          retries: Infinity,
          // A failed model call is not retried on its own: each try is a paid call.
          shouldRetry: ({ error }) => error instanceof Waiting,
        },
      );
      draft = toDraft(proposal);
      proposedAt = proposal.createdAt;
    } catch (error) {
      if (!(error instanceof Waiting)) {
        message = error instanceof Error ? error.message : 'Proposal failed';
      }
    } finally {
      wait = null;
      busy = false;
    }
  };

  const approve = async (event: SubmitEvent) => {
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
  };

  const discard = async () => {
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
  };

  onDestroy(() => (stopped = true));
</script>

<svelte:head><title>Brand guide · Soundboard</title></svelte:head>

<main>
  <a class="back" href={resolve('/')}>Releases</a>
  <div class="intro">
    <h1>Brand guide</h1>
    <p class="help">
      Read from your latest {BRAND_VIDEOS} uploads and {BRAND_THUMBNAILS} thumbnails: one statement, then
      rules to keep, fix, or drop. The approved guide shapes every pick.
    </p>
  </div>

  <div class="guides">
    <section class="panel" aria-labelledby="current">
      <div class="head">
        <h2 id="current">Approved</h2>
        {#if approved}<span class="chip" data-tone="ok">Smart pick follows this</span>{/if}
      </div>
      {#if approved}
        <p class="statement">{approved.statement}</p>
        <ul class="rules">
          {#each LISTS as list (list.key)}
            {#each approved[list.key] as rule, i (i)}
              <li><span class="chip" data-tone={list.tone}>{list.label}</span>{rule}</li>
            {/each}
          {/each}
        </ul>
        <p class="help">
          From {approved.basedOn.length} uploads · approved {new Date(
            approved.approvedAt ?? approved.createdAt,
          ).toLocaleDateString()}
        </p>
      {:else}
        <p class="help">None yet. Smart pick follows the recent uploads until one is approved.</p>
      {/if}
    </section>

    {#if draft}
      <form class="panel proposal" onsubmit={approve} aria-label="Proposed guide">
        <div class="head">
          <h2>Proposal</h2>
          <span class="chip" data-tone="attention">Needs your decision</span>
        </div>
        <div class="field">
          <label for="statement"
            >Statement <span>{draft.statement.length} / {STATEMENT_MAX}</span></label
          >
          <textarea id="statement" rows="4" bind:value={draft.statement} disabled={busy}></textarea>
        </div>
        {#each LISTS as list (list.key)}
          <div class="field">
            <label for={list.key}
              >{list.label}
              <span>one rule per line · up to {RULES_MAX} · {RULE_MAX} chars each</span></label
            >
            <textarea id={list.key} rows="3" bind:value={draft[list.key]} disabled={busy}
            ></textarea>
          </div>
        {/each}
        <div class="actions">
          <button class="btn danger small" type="button" disabled={busy} onclick={discard}
            >Discard</button
          >
          <button class="btn small" type="button" disabled={busy} onclick={propose}
            >{busy ? proposing : 'Propose again'}</button
          >
          <button class="btn primary" type="submit" disabled={busy || Boolean(problem)}
            >Approve</button
          >
        </div>
        <p class="help">Approving replaces the guide in use. Discarding keeps it.</p>
        <p class="toast err" aria-live="polite">{message || problem || ''}</p>
      </form>
    {:else}
      <section class="panel" aria-labelledby="proposal">
        <h2 id="proposal">Proposal</h2>
        <p class="help">
          Propose reads what's already on the channel and writes one statement with rules. Nothing
          changes on YouTube; you approve or discard it here.
        </p>
        <div class="actions">
          <button class="btn primary" type="button" disabled={busy} onclick={propose}
            >{busy ? proposing : 'Propose'}</button
          >
        </div>
        <p class="toast err" aria-live="polite">{message}</p>
      </section>
    {/if}
  </div>
</main>

<style>
  main {
    width: 100%;
    max-width: var(--measure-page);
    margin: 0 auto;
    padding: 40px var(--gutter) 64px;
    display: flex;
    flex-direction: column;
    gap: 28px;
  }

  .back {
    align-self: flex-start;
    color: var(--muted);
    font-size: 14px;
  }

  .intro {
    display: grid;
    gap: 6px;
  }

  .intro p {
    max-width: 64ch;
    font-size: 16px;
  }

  .guides {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
    gap: 24px;
    align-items: start;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
    padding: 24px;
  }

  .proposal {
    border-color: var(--attention);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }

  .statement {
    font-size: 17px;
  }

  .rules {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .rules li {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 10px 0;
    border-top: 1px solid var(--line);
    font-size: 15px;
  }

  .rules .chip {
    flex: none;
    min-width: 52px;
    justify-content: center;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }

  .actions .primary {
    margin-left: auto;
  }
</style>

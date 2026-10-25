<script lang="ts">
  import { onDestroy } from 'svelte';
  import { resolve } from '$app/paths';
  import { approveGuide, discardGuide } from '#lib/api.js';
  import {
    BRAND_THUMBNAILS,
    BRAND_VIDEOS,
    counted,
    guideError,
    RULE_MAX,
    RULES_MAX,
    splitRules,
    STATEMENT_MAX,
    type BrandGuide,
    type GuideState,
    type Proposal,
  } from '#lib/brand.js';
  import { GuideWait, proposeUntilReady } from '#lib/propose.js';
  import { WAIT_TEXT } from '#lib/status.js';
  import type { Wait } from '#lib/types.js';
  import GuideSources from './GuideSources.svelte';

  let { guide }: { guide: GuideState<BrandGuide> } = $props();

  const LISTS = [
    { key: 'keep', label: 'Keep', tone: 'ok' },
    { key: 'fix', label: 'Fix', tone: 'warn' },
    { key: 'drop', label: 'Drop', tone: 'err' },
  ] as const;
  type Draft = { statement: string; keep: string; fix: string; drop: string };

  const toDraft = (body: BrandGuide): Draft => ({
    statement: body.statement,
    keep: body.keep.join('\n'),
    fix: body.fix.join('\n'),
    drop: body.drop.join('\n'),
  });

  // svelte-ignore state_referenced_locally
  let approved = $state(guide.approved);
  // svelte-ignore state_referenced_locally
  let proposal = $state<Proposal<BrandGuide> | null>(guide.proposal);
  // svelte-ignore state_referenced_locally
  let draft = $state<Draft | null>(guide.proposal ? toDraft(guide.proposal.body) : null);
  // svelte-ignore state_referenced_locally
  let held = $state<Wait | null>(
    guide.limitUntil !== null && guide.limitUntil > Date.now() ? 'model quota spent' : null,
  );
  // svelte-ignore state_referenced_locally
  let heldUntil = $state<number | null>(guide.limitUntil);
  let wait = $state<Wait | null>(null);
  let busy = $state(false);
  let message = $state('');
  let stopped = false;

  const edited = $derived(
    draft
      ? {
          statement: draft.statement.trim(),
          keep: splitRules(draft.keep),
          fix: splitRules(draft.fix),
          drop: splitRules(draft.drop),
        }
      : null,
  );
  const problem = $derived(edited ? guideError(edited) : null);
  const shown = $derived(held ?? wait);
  const label = $derived(shown ? WAIT_TEXT[shown] : 'Reading uploads');

  const failed = (error: unknown, fallback: string) => {
    if (error instanceof GuideWait) {
      held = error.wait;
      heldUntil = error.limitUntil;
    } else message = error instanceof Error ? error.message : fallback;
  };

  const propose = async () => {
    busy = true;
    message = '';
    try {
      const next = await proposeUntilReady(
        'brand',
        (w) => (wait = w),
        () => stopped,
      );
      if (next) {
        proposal = next;
        draft = toDraft(next.body);
      }
    } catch (error) {
      failed(error, 'Proposal failed');
    } finally {
      wait = null;
      busy = false;
    }
  };

  // On a 404 the edited text stays in the form beside the message.
  const approve = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!proposal || !edited || problem) return;
    busy = true;
    message = '';
    try {
      approved = (await approveGuide('brand', edited, proposal.id)).approved;
      proposal = null;
      draft = null;
    } catch (error) {
      failed(error, 'Approval failed');
    } finally {
      busy = false;
    }
  };

  const discard = async () => {
    if (!proposal) return;
    busy = true;
    message = '';
    try {
      await discardGuide('brand', proposal.id);
      proposal = null;
      draft = null;
    } catch (error) {
      failed(error, 'Discard failed');
    } finally {
      busy = false;
    }
  };

  // Only the quota hold ends on its own; a lost grant waits for the reconnect.
  $effect(() => {
    if (held !== 'model quota spent') return;
    const timer = setTimeout(() => (held = null), Math.max(0, (heldUntil ?? 0) - Date.now()));
    return () => clearTimeout(timer);
  });

  onDestroy(() => (stopped = true));
</script>

<section class="panel" aria-labelledby="brand-guide">
  <div class="head">
    <h2 id="brand-guide">Brand guide</h2>
    {#if approved}<span class="chip" data-tone="ok">Smart pick follows this</span>{/if}
  </div>
  {#if approved}
    <p class="statement">{approved.body.statement}</p>
    <ul class="rules">
      {#each LISTS as list (list.key)}
        {#each approved.body[list.key] as rule, i (i)}
          <li><span class="chip" data-tone={list.tone}>{list.label}</span>{rule}</li>
        {/each}
      {/each}
    </ul>
    <p class="help">
      {#if approved.sources.carriedOver}
        Carried over from your earlier guide
      {:else}
        From {counted(approved.sources.uploads, 'upload')}, proposed
        {new Date(approved.proposedAt).toLocaleDateString()}
      {/if}
    </p>
  {:else}
    <p class="help">Not set. Drafts run without one.</p>
  {/if}

  {#if proposal && draft}
    <form class="proposal" onsubmit={approve} aria-label="Proposed brand guide">
      <div class="head">
        <h3>Proposal</h3>
        <span class="chip" data-tone="attention">Needs your decision</span>
      </div>
      <GuideSources heading="Read from" uploads={proposal.sources.uploads} />
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
          <textarea id={list.key} rows="3" bind:value={draft[list.key]} disabled={busy}></textarea>
        </div>
      {/each}
      <div class="actions">
        <button class="btn danger small" type="button" disabled={busy} onclick={discard}
          >Discard</button
        >
        <button class="btn small" type="button" disabled={busy || held !== null} onclick={propose}
          >{busy || held ? label : 'Propose again'}</button
        >
        <button class="btn primary" type="submit" disabled={busy || Boolean(problem)}
          >Approve</button
        >
      </div>
      <p class="help">Approving replaces the guide in use. Discarding keeps it.</p>
    </form>
  {:else}
    <p class="help">
      Propose reads your latest {BRAND_VIDEOS} uploads and {BRAND_THUMBNAILS} thumbnails and writes one
      statement with rules to keep, fix, or drop. Nothing changes on YouTube; you approve or discard it
      here.
    </p>
    <div class="actions">
      <button class="btn primary" type="button" disabled={busy || held !== null} onclick={propose}
        >{busy || held ? label : 'Propose'}</button
      >
    </div>
  {/if}
  {#if held === 'reconnect YouTube'}
    <p class="help"><a href={resolve('/connections')}>Reconnect YouTube</a> to propose again.</p>
  {/if}
  <p class="toast err" aria-live="polite">{message || problem || ''}</p>
</section>

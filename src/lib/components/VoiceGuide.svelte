<script lang="ts">
  import { onDestroy } from 'svelte';
  import { resolve } from '$app/paths';
  import { approveGuide, discardGuide } from '#lib/api.js';
  import {
    counted,
    splitRules,
    voiceError,
    VOICE_RULE_MAX,
    VOICE_RULES_MAX,
    type GuideState,
    type Proposal,
    type VoiceRules,
  } from '#lib/brand.js';
  import { GuideWait, proposeUntilReady } from '#lib/propose.js';
  import { WAIT_TEXT } from '#lib/status.js';
  import type { Wait } from '#lib/types.js';
  import GuideSources from './GuideSources.svelte';

  let { guide }: { guide: GuideState<VoiceRules> } = $props();

  // svelte-ignore state_referenced_locally
  let approved = $state(guide.approved);
  // svelte-ignore state_referenced_locally
  let proposal = $state<Proposal<VoiceRules> | null>(guide.proposal);
  // svelte-ignore state_referenced_locally
  let draft = $state(guide.proposal?.body.rules.join('\n') ?? '');
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

  const rules = $derived(splitRules(draft));
  const problem = $derived(proposal ? voiceError({ rules }) : null);
  const shown = $derived(held ?? wait);
  const label = $derived(shown ? WAIT_TEXT[shown] : 'Reading your writing');

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
        'voice',
        (w) => (wait = w),
        () => stopped,
      );
      if (next) {
        proposal = next;
        draft = next.body.rules.join('\n');
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
    if (!proposal || problem) return;
    busy = true;
    message = '';
    try {
      approved = (await approveGuide('voice', { rules }, proposal.id)).approved;
      proposal = null;
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
      await discardGuide('voice', proposal.id);
      proposal = null;
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

<section class="panel" aria-labelledby="voice">
  <div class="head">
    <h2 id="voice">Voice</h2>
    {#if approved}<span class="chip" data-tone="ok">Drafts follow this</span>{/if}
  </div>
  {#if approved}
    <ul class="rules">
      {#each approved.body.rules as rule, i (i)}<li>{rule}</li>{/each}
    </ul>
    <p class="help">
      {#if approved.sources.carriedOver}
        Carried over from your earlier rules
      {:else}
        From {counted(approved.sources.uploads, 'upload')},
        {counted(approved.sources.drafts, 'Soundboard draft')},
        {counted(approved.sources.edits, 'edit')} and {counted(
          approved.sources.approvals,
          'approval',
        )}, proposed
        {new Date(approved.proposedAt).toLocaleDateString()}
      {/if}
    </p>
  {:else}
    <p class="help">Not set. Drafts use plain, generic rules.</p>
  {/if}

  {#if proposal}
    <form class="proposal" onsubmit={approve} aria-label="Proposed voice">
      <div class="head">
        <h3>Proposal</h3>
        <span class="chip" data-tone="attention">Needs your decision</span>
      </div>
      <GuideSources heading="Written by you" uploads={proposal.sources.uploads} />
      <GuideSources heading="Approved Soundboard drafts" uploads={proposal.sources.drafts} />
      <p class="help">
        {counted(proposal.sources.edits, 'edit')} and {counted(
          proposal.sources.approvals,
          'approval',
        )}
        in Soundboard
      </p>
      {#if proposal.sources.thin}
        <p class="help">
          Little writing to learn from: {counted(proposal.sources.uploads.length, 'description')},
          {counted(proposal.sources.edits, 'edit')}.
        </p>
      {/if}
      <div class="field">
        <label for="voice-rules"
          >Rules <span
            >one rule per line · up to {VOICE_RULES_MAX} · {VOICE_RULE_MAX} chars each</span
          ></label
        >
        <textarea id="voice-rules" rows="8" bind:value={draft} disabled={busy}></textarea>
      </div>
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
      <p class="help">Approving replaces the voice in use. Discarding keeps it.</p>
    </form>
  {:else}
    <p class="help">
      Propose reads your own video descriptions and your edits in Soundboard, then writes rules for
      how you write. You approve or discard them here.
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

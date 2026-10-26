<script lang="ts">
  import { resolve } from '$app/paths';
  import { ApiError, saveInfluence } from '#lib/api.js';
  import { ROLES, type Influence, type Level, type Role } from '#lib/influence.js';

  let {
    initial,
    canSave,
    onsaved,
  }: {
    /** The saved settings, or the defaults; the form edits its own copy. */
    initial: Influence;
    /** Whether an approved brand guide exists to save them on. */
    canSave: boolean;
    onsaved: (influence: Influence) => void | Promise<void>;
  } = $props();

  // What each part draws on at 0, before any peer influence.
  const SOURCES: Record<Role, { name: string; source: string }> = {
    sound: { name: 'Sound', source: 'Song analysis; peer vocabulary may help describe it' },
    feel: { name: 'Feel', source: "The artist's own writing and approved edits" },
    wording: { name: 'Wording', source: "The artist's phrasing, sentence shape, and asides" },
    discovery: {
      name: 'Discovery',
      source:
        'Eligible peer tags, hashtags, and title keywords, limited to what the analysis heard',
    },
    structure: {
      name: 'Structure',
      source: "Peer patterns for length and order; the artist's own identity and credit lines",
    },
  };

  const ENDS: Partial<Record<number, string>> = { 0: '0, your own', 4: '4, strongest peer' };
  const valueText = (level: number) => ENDS[level] ?? String(level);

  // svelte-ignore state_referenced_locally
  let levels = $state<Influence>({ ...initial });
  let message = $state('');
  let failed = $state(false);
  let saved = $state(false);
  let busy = $state(false);

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    busy = true;
    failed = false;
    saved = false;
    message = '';
    try {
      const { influence } = await saveInfluence({ ...levels });
      saved = true;
      await onsaved(influence);
    } catch (error) {
      failed = true;
      message = error instanceof ApiError ? error.message : "Couldn't save. Try again.";
    } finally {
      busy = false;
    }
  };
</script>

<form onsubmit={save} aria-label="Peer influence">
  {#each ROLES as role (role)}
    <div class="role">
      <label for="influence-{role}">
        {SOURCES[role].name}
        <output for="influence-{role}">{levels[role]}</output>
      </label>
      <p class="help" id="influence-{role}-source">{SOURCES[role].source}</p>
      <input
        id="influence-{role}"
        type="range"
        min="0"
        max="4"
        step="1"
        value={levels[role]}
        oninput={(event) => (levels[role] = Number(event.currentTarget.value) as Level)}
        aria-valuetext={valueText(levels[role])}
        aria-describedby="influence-{role}-source"
        disabled={busy}
      />
      <div class="ends" aria-hidden="true"><span>Your own</span><span>Strongest peer</span></div>
    </div>
  {/each}
  {#if !canSave}
    <p class="help">
      Approve your brand guide to save your own settings. Drafts use these defaults until then.
      <a href={resolve('/brand')}>Brand</a>
    </p>
  {/if}
  <div class="actions">
    <button class="btn primary" type="submit" disabled={busy || !canSave}>Save settings</button>
  </div>
  <p class="toast" class:err={failed} aria-live="polite">
    {message || (saved ? 'Saved. Applies to later drafts.' : '')}
  </p>
</form>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .role {
    display: grid;
    gap: 6px;
    padding: 14px 0;
    border-top: 1px solid var(--line);
  }

  label {
    display: flex;
    gap: 12px;
    font-weight: 600;
  }

  output {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  input[type='range'] {
    width: 100%;
    max-width: 420px;
  }

  .ends {
    display: flex;
    justify-content: space-between;
    max-width: 420px;
    color: var(--muted);
    font-size: 13px;
  }
</style>

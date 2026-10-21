<script lang="ts">
  import { page } from '$app/state';

  const NOTICES = new Map([
    ['denied', "That Google account isn't invited."],
    ['expired', 'Sign-in expired. Try again.'],
  ]);

  const notice = $derived(NOTICES.get(page.url.searchParams.get('signin') ?? '') ?? null);
</script>

{#if notice}
  <p class="notice" role="status">{notice}</p>
{/if}

<style>
  .notice {
    margin: 0;
    padding: 10px 14px;
    border-left: 3px solid var(--info);
    background: var(--panel);
    font-size: 14px;
  }
</style>

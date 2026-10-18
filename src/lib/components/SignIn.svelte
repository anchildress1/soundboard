<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  const NOTICES = new Map([
    ['denied', "That Google account isn't invited."],
    ['expired', 'Sign-in expired. Try again.'],
  ]);

  const notice = $derived(NOTICES.get(page.url.searchParams.get('signin') ?? '') ?? null);
</script>

<section aria-label="Sign in">
  {#if notice}
    <p class="notice" role="status">{notice}</p>
  {/if}
  <!-- A full page load: the login route redirects off-site to Google. -->
  <a class="btn primary" href={resolve('/auth/login')} data-sveltekit-reload>Sign in with Google</a>
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
  }

  .notice {
    margin: 0;
    padding: 10px 14px;
    border-left: 3px solid var(--info);
    background: var(--panel);
    font-size: 14px;
  }
</style>

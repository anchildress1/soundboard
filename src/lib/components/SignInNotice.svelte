<script lang="ts">
  import { page } from '$app/state';

  const NOTICES = new Map([
    [
      'denied',
      {
        title: "That Google account isn't invited",
        body: 'Nothing was saved. Ask Ashley to add your email, then try again.',
      },
    ],
    [
      'expired',
      {
        title: 'Your sign-in expired',
        body: 'Sign in again. Your releases are where you left them.',
      },
    ],
  ]);

  const notice = $derived(NOTICES.get(page.url.searchParams.get('signin') ?? '') ?? null);
</script>

{#if notice}
  <div class="notice" data-tone="warn" role="status">
    <strong>{notice.title}</strong>
    <span class="help">{notice.body}</span>
  </div>
{/if}

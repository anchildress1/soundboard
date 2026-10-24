<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  const notFound = $derived(page.status === 404);
</script>

<svelte:head>
  <title>{notFound ? 'Not found' : 'Error'} · Soundboard</title>
</svelte:head>

<main aria-labelledby="error-title">
  <p class="status num" aria-hidden="true">{page.status}</p>
  <h1 id="error-title">{notFound ? 'Page not found' : 'Something went wrong'}</h1>
  <p class="help">
    {notFound
      ? "There's nothing at this address. The link may be old, or the release may be gone."
      : (page.error?.message ?? 'The server hit an error.')}
  </p>
  <a class="btn primary" href={resolve('/')}>Back to releases</a>
</main>

<style>
  main {
    width: 100%;
    max-width: 520px;
    margin: 0 auto;
    padding: 64px var(--gutter);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }

  .status {
    font-size: 14px;
    font-weight: 600;
    color: var(--attention);
  }

  .help {
    max-width: 48ch;
    font-size: 16px;
  }

  .btn {
    margin-top: 8px;
  }
</style>

<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';

  const notFound = $derived(page.status === 404);
</script>

<svelte:head>
  <title>{notFound ? 'Not found' : 'Error'} · Soundboard</title>
</svelte:head>

<main>
  <section class="error" aria-labelledby="error-title">
    <p class="status" aria-hidden="true">{page.status}</p>
    <h2 id="error-title">{notFound ? 'Page not found' : 'Something went wrong'}</h2>
    <p>
      {notFound
        ? "There's nothing at this address. The link may be old, or the job may be gone."
        : (page.error?.message ?? 'The server hit an error.')}
    </p>
    <a class="btn primary" href={resolve('/')}>Back to Soundboard</a>
  </section>
</main>

<style>
  .error {
    max-width: 560px;
    margin: 40px auto;
    display: grid;
    justify-items: start;
    gap: 12px;
  }

  .status {
    margin: 0;
    font: 900 clamp(72px, 16vw, 128px) / 0.9 var(--display);
    color: var(--blue);
    text-shadow:
      0 0 18px rgba(46, 140, 255, 0.55),
      0 0 2px rgba(46, 140, 255, 0.9);
  }

  h2 {
    margin: 0;
    font: 900 22px/1.2 var(--display);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  p {
    margin: 0;
    color: var(--muted);
  }

  .btn {
    margin-top: 8px;
    text-decoration: none;
  }
</style>

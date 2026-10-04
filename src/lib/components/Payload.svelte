<script lang="ts">
  import type { PickFields } from '$lib/types';

  let { fields }: { fields: PickFields } = $props();
</script>

<section class="payload" aria-label="Would-be upload payload">
  <h2>Would-be payload</h2>
  <pre>{JSON.stringify(
      {
        snippet: {
          title: fields.title,
          description: fields.description,
          tags: fields.tags,
          categoryId: '10',
        },
        status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
      },
      null,
      2,
    )}</pre>
</section>

<style>
  .payload {
    background: var(--panel);
    padding: 12px 14px;
  }

  h2 {
    margin: 0 0 6px;
    font: 900 12px/1.2 var(--display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }

  pre {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: 500 12px/1.5 var(--mono);
    color: var(--ink);
  }
</style>

<script lang="ts">
  import type { UploadSource } from '#lib/brand.js';

  let { heading, uploads }: { heading: string; uploads: UploadSource[] } = $props();
</script>

{#if uploads.length > 0}
  <div class="sources">
    <h3>{heading}</h3>
    <ul>
      {#each uploads as upload (upload.videoId)}
        <li>
          <a
            href={`https://www.youtube.com/watch?v=${encodeURIComponent(upload.videoId)}`}
            target="_blank"
            rel="noopener noreferrer">{upload.title || upload.videoId}</a
          >
          <span class="help">{new Date(upload.publishedAt).toLocaleDateString()}</span>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .sources {
    display: grid;
    gap: 6px;
  }

  h3 {
    font-size: 15px;
  }

  ul {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 14px;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
    min-width: 0;
  }

  a {
    overflow-wrap: anywhere;
  }
</style>

<script lang="ts">
  import { resolution, timecode } from '$lib/format';

  let {
    src = null,
    filename = '',
    height = null,
    duration = $bindable(0),
  }: {
    src?: string | null;
    filename?: string;
    height?: number | null;
    duration?: number;
  } = $props();

  let currentTime = $state(0);
  let videoHeight = $state(0);
  const label = $derived(resolution(height ?? (videoHeight || null)));
</script>

<div class="monitor">
  {#if src}
    <!-- Music videos carry their own audio; there is no caption track to offer. -->
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      {src}
      controls
      playsinline
      preload="metadata"
      bind:currentTime
      bind:duration
      bind:videoHeight
    ></video>
  {:else}
    <div class="scene" aria-hidden="true"></div>
  {/if}
  {#if filename}<span class="file">{filename}</span>{/if}
  {#if label}<span class="rec"><i></i>{label}</span>{/if}
  {#if src}<span class="tc">{timecode(currentTime)} / {timecode(duration)}</span>{/if}
</div>

<style>
  .monitor {
    position: relative;
    aspect-ratio: 16/9;
    max-width: 100%;
    background: #000;
    border: 1px solid var(--line);
    overflow: hidden;
  }

  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: #000;
  }

  .scene {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(60% 80% at 40% 60%, rgba(31, 111, 232, 0.55), transparent 60%),
      radial-gradient(50% 70% at 75% 35%, rgba(255, 122, 26, 0.7), transparent 62%),
      radial-gradient(30% 40% at 60% 80%, rgba(255, 79, 216, 0.5), transparent 70%), #000;
  }

  .scene::before {
    content: '';
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.28) 0 2px, transparent 2px 5px);
  }

  .scene::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 46%;
    height: 9px;
    background: var(--magenta);
    opacity: 0.85;
    transform: skewY(-1.5deg);
  }

  .tc,
  .rec,
  .file {
    position: absolute;
    font: 500 11px/1 var(--mono);
    background: rgba(0, 0, 0, 0.6);
    padding: 5px 7px;
    pointer-events: none;
  }

  .tc {
    left: 12px;
    bottom: 48px;
    font-size: 12px;
    color: var(--ink);
  }

  .rec {
    right: 12px;
    top: 10px;
    letter-spacing: 0.1em;
    color: var(--ink);
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .rec i {
    width: 8px;
    height: 8px;
    background: var(--red);
    border-radius: 50%;
  }

  .file {
    left: 12px;
    top: 10px;
    color: var(--muted);
    max-width: 70%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

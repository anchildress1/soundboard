<script lang="ts">
  import { resolution, timecode } from '#lib/format.js';

  let {
    src = null,
    filename = '',
    width = null,
    height = null,
    vertical = false,
    duration = $bindable(0),
  }: {
    src?: string | null;
    filename?: string;
    width?: number | null;
    height?: number | null;
    /** 9:16 frame for a Short. */
    vertical?: boolean;
    duration?: number;
  } = $props();

  let currentTime = $state(0);
  let videoWidth = $state(0);
  let videoHeight = $state(0);
  // The probe applies the file's rotation; the decoded size is only a fallback before it lands.
  const label = $derived(
    height ? resolution(width, height) : resolution(videoWidth || null, videoHeight || null),
  );
</script>

<div class="monitor" class:vertical>
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
      bind:videoWidth
      bind:videoHeight
    ></video>
  {:else}
    <div class="scene" aria-hidden="true"></div>
  {/if}
  {#if filename}<span class="file">{filename}</span>{/if}
  {#if label}<span class="rec">{label}</span>{/if}
  {#if src}<span class="tc">{timecode(currentTime)} / {timecode(duration)}</span>{/if}
</div>

<style>
  .monitor {
    position: relative;
    aspect-ratio: 16/9;
    max-width: 100%;
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    background: var(--ground);
    overflow: hidden;
  }

  .monitor.vertical {
    aspect-ratio: 9/16;
    width: min(100%, 320px);
    margin: 0 auto;
  }

  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: var(--ground);
  }

  .scene {
    position: absolute;
    inset: 0;
    background: var(--panel);
  }

  .tc,
  .rec,
  .file {
    position: absolute;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--scrim);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    color: var(--ink);
    pointer-events: none;
  }

  .tc {
    left: 12px;
    bottom: 52px;
  }

  .rec {
    right: 12px;
    top: 10px;
  }

  .file {
    left: 12px;
    top: 10px;
    max-width: 65%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }
</style>

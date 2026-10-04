import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Monitor from '$lib/components/Monitor.svelte';

const media = (el: Element, props: Record<string, number>) => {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(el, key, { configurable: true, get: () => value });
  }
};

describe('Monitor', () => {
  it('frames a Short at 9:16 when vertical', () => {
    const { container } = render(Monitor, {
      src: 'https://storage.googleapis.com/b/s',
      vertical: true,
    });
    expect(container.querySelector('.monitor')).toHaveClass('vertical');
  });

  it('keeps the 16:9 frame by default', () => {
    const { container } = render(Monitor, {});
    expect(container.querySelector('.monitor')).not.toHaveClass('vertical');
  });

  it('shows the test scene and no timecode without a source', () => {
    const { container } = render(Monitor, {});
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('.scene')).not.toBeNull();
    expect(container.querySelector('.tc')).toBeNull();
    expect(container.querySelector('.rec')).toBeNull();
    expect(container.querySelector('.file')).toBeNull();
  });

  it('plays the source with filename, resolution, and timecode overlays', () => {
    const { container } = render(Monitor, {
      src: 'blob:local',
      filename: 'peekaboo.mp4',
      height: 1080,
    });
    const video = container.querySelector('video')!;
    expect(video).toHaveAttribute('src', 'blob:local');
    expect(video).toHaveAttribute('playsinline');
    expect(screen.getByText('peekaboo.mp4')).toBeInTheDocument();
    expect(screen.getByText('1080p')).toBeInTheDocument();
    expect(screen.getByText('00:00:00 / 00:00:00')).toBeInTheDocument();
  });

  it('tracks time, duration, and the decoded height', async () => {
    const { container } = render(Monitor, { src: 'https://storage.googleapis.com/b/o' });
    const video = container.querySelector('video')!;
    media(video, { duration: 3725, currentTime: 65, videoWidth: 1280, videoHeight: 720 });
    await fireEvent(video, new Event('durationchange'));
    await fireEvent(video, new Event('timeupdate'));
    await fireEvent(video, new Event('resize'));
    expect(screen.getByText('00:01:05 / 01:02:05')).toBeInTheDocument();
    expect(screen.getByText('720p')).toBeInTheDocument();
  });

  it('marks a probed vertical video', () => {
    render(Monitor, { src: 'blob:x', width: 720, height: 1280 });
    expect(screen.getByText('720p · vertical')).toBeInTheDocument();
  });

  it('prefers the probed height over the decoded one', async () => {
    const { container } = render(Monitor, { src: 'blob:x', height: 360 });
    const video = container.querySelector('video')!;
    media(video, { videoHeight: 720 });
    await fireEvent(video, new Event('resize'));
    expect(screen.getByText('360p')).toBeInTheDocument();
  });
});

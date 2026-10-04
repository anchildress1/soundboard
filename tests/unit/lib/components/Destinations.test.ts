import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import Destinations from '$lib/components/Destinations.svelte';

const panel = (text: string) => createRawSnippet(() => ({ render: () => `<p>${text}</p>` }));

const setup = (youtubeDone = false, bandcampDone = false) =>
  render(Destinations, {
    youtube: panel('YouTube panel'),
    bandcamp: panel('Bandcamp panel'),
    youtubeDone,
    bandcampDone,
  });

describe('Destinations', () => {
  it('opens on YouTube with Bandcamp hidden', () => {
    setup();
    expect(screen.getByRole('tab', { name: /YouTube/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('YouTube panel')).toBeVisible();
    expect(screen.queryByText('Bandcamp panel')).not.toBeVisible();
  });

  it('switches panels on click', async () => {
    setup();
    await fireEvent.click(screen.getByRole('tab', { name: /Bandcamp/ }));
    expect(screen.getByRole('tab', { name: /Bandcamp/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Bandcamp panel')).toBeVisible();
    expect(screen.queryByText('YouTube panel')).not.toBeVisible();
  });

  it('moves between tabs with the arrow keys, wrapping around', async () => {
    setup();
    const youtube = screen.getByRole('tab', { name: /YouTube/ });
    await fireEvent.keyDown(youtube, { key: 'ArrowRight' });
    const bandcamp = screen.getByRole('tab', { name: /Bandcamp/ });
    expect(bandcamp).toHaveFocus();
    expect(bandcamp).toHaveAttribute('tabindex', '0');
    expect(youtube).toHaveAttribute('tabindex', '-1');
    await fireEvent.keyDown(bandcamp, { key: 'ArrowRight' });
    expect(youtube).toHaveFocus();
    await fireEvent.keyDown(youtube, { key: 'ArrowLeft' });
    expect(bandcamp).toHaveFocus();
    await fireEvent.keyDown(bandcamp, { key: 'Enter' });
    expect(bandcamp).toHaveAttribute('aria-selected', 'true');
  });

  it('marks each destination done or to do', () => {
    setup(true, false);
    expect(screen.getByRole('tab', { name: /YouTube/ })).toHaveTextContent('✓ YouTube Done');
    expect(screen.getByRole('tab', { name: /Bandcamp/ })).toHaveTextContent('● Bandcamp To do');
  });
});

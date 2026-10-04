import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import Destinations from '$lib/components/Destinations.svelte';

const panel = (text: string) => createRawSnippet(() => ({ render: () => `<p>${text}</p>` }));

const setup = (youtubeDone = false, bandcampDone = false, shortDone = false) =>
  render(Destinations, {
    youtube: panel('YouTube panel'),
    short: panel('Short panel'),
    bandcamp: panel('Bandcamp panel'),
    youtubeDone,
    shortDone,
    bandcampDone,
  });

const tab = (name: RegExp) => screen.getByRole('tab', { name });

describe('Destinations', () => {
  it('opens on YouTube with the other panels hidden', () => {
    setup();
    expect(tab(/YouTube/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('YouTube panel')).toBeVisible();
    expect(screen.queryByText('Short panel')).not.toBeVisible();
    expect(screen.queryByText('Bandcamp panel')).not.toBeVisible();
  });

  it('orders the tabs YouTube, Short, Bandcamp, each tied to its panel', () => {
    setup();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.id)).toEqual(['tab-youtube', 'tab-short', 'tab-bandcamp']);
    for (const t of tabs) {
      const panelId = t.getAttribute('aria-controls')!;
      expect(document.getElementById(panelId)).toHaveAttribute('aria-labelledby', t.id);
    }
  });

  it('switches panels on click', async () => {
    setup();
    await fireEvent.click(tab(/Bandcamp/));
    expect(tab(/Bandcamp/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Bandcamp panel')).toBeVisible();
    expect(screen.queryByText('YouTube panel')).not.toBeVisible();
    await fireEvent.click(tab(/Short/));
    expect(screen.getByText('Short panel')).toBeVisible();
  });

  it('moves between tabs with the arrow keys, wrapping around', async () => {
    setup();
    const youtube = tab(/YouTube/);
    await fireEvent.keyDown(youtube, { key: 'ArrowRight' });
    const short = tab(/Short/);
    expect(short).toHaveFocus();
    expect(short).toHaveAttribute('tabindex', '0');
    expect(youtube).toHaveAttribute('tabindex', '-1');
    await fireEvent.keyDown(short, { key: 'ArrowRight' });
    const bandcamp = tab(/Bandcamp/);
    expect(bandcamp).toHaveFocus();
    await fireEvent.keyDown(bandcamp, { key: 'ArrowRight' });
    expect(youtube).toHaveFocus();
    await fireEvent.keyDown(youtube, { key: 'ArrowLeft' });
    expect(bandcamp).toHaveFocus();
    await fireEvent.keyDown(bandcamp, { key: 'Enter' });
    expect(bandcamp).toHaveAttribute('aria-selected', 'true');
  });

  it('jumps to the first and last tab with Home and End', async () => {
    setup();
    await fireEvent.keyDown(tab(/YouTube/), { key: 'End' });
    expect(tab(/Bandcamp/)).toHaveFocus();
    expect(tab(/Bandcamp/)).toHaveAttribute('aria-selected', 'true');
    await fireEvent.keyDown(tab(/Bandcamp/), { key: 'Home' });
    expect(tab(/YouTube/)).toHaveFocus();
  });

  it('marks each destination done or to do', () => {
    setup(true, false, true);
    expect(tab(/YouTube/)).toHaveTextContent('✓ YouTube Done');
    expect(tab(/Short/)).toHaveTextContent('✓ Short Done');
    expect(tab(/Bandcamp/)).toHaveTextContent('● Bandcamp To do');
  });
});

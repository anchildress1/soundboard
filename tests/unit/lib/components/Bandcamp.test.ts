import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Bandcamp from '$lib/components/Bandcamp.svelte';
import type { Pick } from '$lib/types';

const pick: Pick = {
  version: 1,
  title: 'Vaporgram - Flies Like Robots',
  description: 'Vaporgram by Flies Like Robots',
  hashtags: ['#vaporwave'],
  tags: ['vaporwave', 'glitch', 'Flies Like Robots'],
  flags: [],
  brandCheck: '',
  why: { title: '', description: '', tags: '' },
  bandcamp: {
    about: 'A terminal screen and some noise.',
    credits: 'Written, performed, recorded, hacked and slashed by Nathan.',
  },
  modelMs: 1,
};

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

const field = (label: string) => screen.getByText(label, { selector: 'dt' }).closest('.field')!;

describe('Bandcamp', () => {
  it('shows the track name, about, credits, and tags for the editor', () => {
    render(Bandcamp, { songTitle: 'Vaporgram', pick });
    expect(within(field('Track name') as HTMLElement).getByText('Vaporgram')).toBeInTheDocument();
    expect(screen.getByText('A terminal screen and some noise.')).toBeInTheDocument();
    expect(screen.getByText(/hacked and slashed by Nathan/)).toBeInTheDocument();
    expect(screen.getByText('vaporwave, glitch, Flies Like Robots')).toBeInTheDocument();
  });

  it("opens Bandcamp's new-track page in a new tab", () => {
    render(Bandcamp, { songTitle: 'Vaporgram', pick });
    const open = screen.getByRole('link', { name: "Open Bandcamp's new-track page" });
    expect(open).toHaveAttribute('href', 'https://flieslikerobots.bandcamp.com/edit_track');
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('copies one field and says so', async () => {
    render(Bandcamp, { songTitle: 'Vaporgram', pick });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy About' }));
    expect(writeText).toHaveBeenCalledWith('A terminal screen and some noise.');
    expect(screen.getByRole('button', { name: 'Copy About' })).toHaveTextContent('Copied');
    expect(screen.getByRole('button', { name: 'Copy Credits' })).toHaveTextContent('Copy');
    expect(screen.getByText('About copied')).toBeInTheDocument();
  });

  it('shows no copied state when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(Bandcamp, { songTitle: 'Vaporgram', pick });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy Tags' }));
    expect(screen.getByRole('button', { name: 'Copy Tags' })).toHaveTextContent('Copy');
    expect(screen.queryByText(/copied$/)).toBeNull();
  });

  it('disables copying an empty field', () => {
    render(Bandcamp, {
      songTitle: 'Vaporgram',
      pick: { ...pick, bandcamp: { about: '', credits: 'x' } },
    });
    expect(screen.getByRole('button', { name: 'Copy About' })).toBeDisabled();
  });
});

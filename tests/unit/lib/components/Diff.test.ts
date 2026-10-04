import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Diff from '$lib/components/Diff.svelte';
import type { LiveMetadata, Pick } from '$lib/types';

const live: LiveMetadata = {
  videoId: 'abc123',
  title: 'Neon',
  description: '',
  tags: ['synthwave', 'retro'],
};

const pick: Pick = {
  version: 1,
  title: 'Neon (Official Video)',
  description: 'Night drive.\n\n#synthwave',
  hashtags: ['#synthwave'],
  tags: ['synthwave', 'Neon', 'Flies Like Robots'],
  flags: [],
  brandCheck: '',
  why: {
    title: 'Adds the format tag.',
    description: 'Fills the empty field.',
    tags: 'Adds the artist.',
  },
  bandcamp: { about: 'Night drive.', credits: 'Written by Nathan.' },
  modelMs: 1,
};

const row = (field: string) =>
  screen.getByRole('heading', { level: 3, name: field }).parentElement!;

describe('Diff', () => {
  it('links the live video', () => {
    render(Diff, { live, pick });
    const link = screen.getByRole('link', { name: 'youtu.be/abc123' });
    expect(link).toHaveAttribute('href', 'https://youtu.be/abc123');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows current vs proposed with a reason for each field', () => {
    render(Diff, { live, pick });
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Title',
      'Description',
      'Tags',
    ]);
    const title = within(row('Title'));
    expect(title.getByText('Neon')).toBeInTheDocument();
    expect(title.getByText('Neon (Official Video)')).toBeInTheDocument();
    expect(row('Title')).toHaveTextContent('Why Adds the format tag.');
    expect(within(row('Tags')).getByText('synthwave, retro')).toBeInTheDocument();
    expect(within(row('Tags')).getByText('synthwave, Neon, Flies Like Robots')).toBeInTheDocument();
  });

  it('marks an empty live field', () => {
    render(Diff, { live, pick });
    expect(within(row('Description')).getByText('(empty)')).toBeInTheDocument();
  });

  it('handles a live video with no tags', () => {
    render(Diff, { live: { ...live, tags: [] }, pick });
    expect(within(row('Tags')).getByText('(empty)')).toBeInTheDocument();
  });

  it('follows a new pick and live video', async () => {
    const { rerender } = render(Diff, { live, pick });
    await rerender({
      live: { ...live, videoId: 'xyz', description: 'Old copy' },
      pick: { ...pick, title: 'Neon v2', why: { ...pick.why, title: 'Fresh.' } },
    });
    expect(screen.getByRole('link', { name: 'youtu.be/xyz' })).toHaveAttribute(
      'href',
      'https://youtu.be/xyz',
    );
    expect(within(row('Title')).getByText('Neon v2')).toBeInTheDocument();
    expect(within(row('Description')).getByText('Old copy')).toBeInTheDocument();
    expect(row('Title')).toHaveTextContent('Why Fresh.');
  });
});

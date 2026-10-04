import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Heard from '$lib/components/Heard.svelte';

const measurements = {
  integratedLufs: -13.84,
  truePeakDbtp: -0.42,
  peakLevelDb: -1,
  clippedSamples: 3,
  silences: [{ start: 1, end: 4 }],
};

describe('Heard', () => {
  it('lists the perceptual tags', () => {
    render(Heard, { tags: ['synthwave', 'driving', 'male lead'], measurements: null });
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'synthwave',
      'driving',
      'male lead',
    ]);
    expect(screen.queryByText(/Tags appear/)).toBeNull();
  });

  it('explains the empty state before any chunk is analyzed', () => {
    render(Heard, { tags: [], measurements: null });
    expect(screen.getByText('Tags appear as each chunk is analyzed.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText('ffmpeg')).toBeNull();
  });

  it('shows the ffmpeg numbers, labeled as ffmpeg', () => {
    render(Heard, { tags: [], measurements });
    const line = screen.getByText('ffmpeg').parentElement!;
    expect(line).toHaveTextContent('ffmpeg -13.8 LUFS · -0.4 dBTP · 3 clipped · 1 silences');
  });

  it('leaves out loudness numbers ffmpeg could not measure', () => {
    render(Heard, {
      tags: [],
      measurements: { ...measurements, integratedLufs: null, truePeakDbtp: null, silences: [] },
    });
    const line = screen.getByText('ffmpeg').parentElement!;
    expect(line).toHaveTextContent('ffmpeg 3 clipped · 0 silences');
    expect(line.textContent).not.toContain('LUFS');
  });

  it('shows only what was heard and measured, no claims about the pick', () => {
    render(Heard, { tags: [], measurements: null });
    expect(screen.queryByText(/most-viewed|grounded/i)).toBeNull();
  });

  it('fills in as chunks arrive', async () => {
    const { rerender } = render(Heard, { tags: [], measurements: null });
    await rerender({ tags: ['synthwave'], measurements });
    expect(screen.getByRole('listitem')).toHaveTextContent('synthwave');
    expect(screen.getByText('ffmpeg')).toBeInTheDocument();
    await rerender({ tags: [], measurements: null });
    expect(screen.queryByRole('list')).toBeNull();
  });
});

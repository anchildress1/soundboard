import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Track from '$lib/components/Track.svelte';

describe('Track', () => {
  it('shows the state chip, progress, and model label', () => {
    render(Track, {
      status: { tone: 'info', text: 'Chunk 2 / 5', progress: 40 },
      model: 'gemma-4-12b-it · 12s',
    });
    const chip = screen.getByRole('status');
    expect(chip).toHaveTextContent('Chunk 2 / 5');
    expect(chip).toHaveAttribute('data-tone', 'info');
    expect(chip).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByText('gemma-4-12b-it · 12s')).toBeInTheDocument();
  });

  it.each([
    ['warn', 'Needs review'],
    ['ok', 'Verified · private'],
    ['err', 'Failed'],
  ] as const)('tones the chip %s', (tone, text) => {
    render(Track, { status: { tone, text, progress: 100 }, model: 'gemma-4-12b-it' });
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', tone);
    expect(screen.getByRole('status')).toHaveTextContent(text);
  });

  it('renders an empty bar at zero progress', () => {
    const { container } = render(Track, {
      status: { tone: 'err', text: 'Discarded', progress: 0 },
      model: 'gemma-4-12b-it',
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(container.querySelector('.bar i')?.getAttribute('style')).toContain('--p: 0%');
  });

  it('updates as the job moves', async () => {
    const { rerender } = render(Track, {
      status: { tone: 'info', text: 'Chunk 1 / 2', progress: 6 },
      model: 'gemma-4-12b-it',
    });
    await rerender({
      status: { tone: 'warn', text: 'Needs review', progress: 100 },
      model: 'gemma-4-12b-it · 9s',
    });
    expect(screen.getByRole('status')).toHaveTextContent('Needs review');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('gemma-4-12b-it · 9s')).toBeInTheDocument();
  });
});

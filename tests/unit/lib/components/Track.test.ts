import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Track from '$lib/components/Track.svelte';

const VALUE_NOW = 'aria-valuenow';
const NEEDS_REVIEW = 'Needs review';
const MODEL = 'gemma-4-12b-it';

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
    expect(screen.getByRole('progressbar')).toHaveAttribute(VALUE_NOW, '40');
    expect(screen.getByText('gemma-4-12b-it · 12s')).toBeInTheDocument();
  });

  it.each([
    ['warn', NEEDS_REVIEW],
    ['ok', 'Verified · private'],
    ['err', 'Failed'],
  ] as const)('tones the chip %s', (tone, text) => {
    render(Track, { status: { tone, text, progress: 100 }, model: MODEL });
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', tone);
    expect(screen.getByRole('status')).toHaveTextContent(text);
  });

  it('renders an empty bar at zero progress', () => {
    const { container } = render(Track, {
      status: { tone: 'err', text: 'Discarded', progress: 0 },
      model: MODEL,
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute(VALUE_NOW, '0');
    expect(container.querySelector('.bar i')?.getAttribute('style')).toContain('--p: 0%');
  });

  it('updates as the job moves', async () => {
    const { rerender } = render(Track, {
      status: { tone: 'info', text: 'Chunk 1 / 2', progress: 6 },
      model: MODEL,
    });
    await rerender({
      status: { tone: 'warn', text: NEEDS_REVIEW, progress: 100 },
      model: 'gemma-4-12b-it · 9s',
    });
    expect(screen.getByRole('status')).toHaveTextContent(NEEDS_REVIEW);
    expect(screen.getByRole('progressbar')).toHaveAttribute(VALUE_NOW, '100');
    expect(screen.getByText('gemma-4-12b-it · 9s')).toBeInTheDocument();
  });
});

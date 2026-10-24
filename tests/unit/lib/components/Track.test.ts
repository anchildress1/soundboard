import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Track from '$lib/components/Track.svelte';

const VALUE_NOW = 'aria-valuenow';
const NEEDS_REVIEW = 'Needs review';
const MODEL = 'Configured analyst: gemini-3.8-flash';

describe('Track', () => {
  it('shows the state chip, progress, model label, and total model time apart', () => {
    render(Track, {
      status: { tone: 'info', text: 'Chunk 2 / 5', progress: 40 },
      model: MODEL,
      seconds: 12,
    });
    const chip = screen.getByRole('status');
    expect(chip).toHaveTextContent('Chunk 2 / 5');
    expect(chip).toHaveAttribute('data-tone', 'info');
    expect(chip).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('progressbar')).toHaveAttribute(VALUE_NOW, '40');
    expect(screen.getByText(MODEL)).toBeInTheDocument();
    expect(screen.getByText('Total model time: 12s')).toBeInTheDocument();
  });

  it('shows no model time before the model has run', () => {
    render(Track, { status: { tone: 'info', text: 'Measuring audio', progress: 4 }, model: MODEL });
    expect(screen.getByText(MODEL)).toBeInTheDocument();
    expect(screen.queryByText(/Total model time/)).toBeNull();
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
});

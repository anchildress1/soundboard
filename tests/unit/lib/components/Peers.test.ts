import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Peers from '#lib/components/Peers.svelte';
import type { ComponentProps } from 'svelte';
import { PEER, SECOND_PEER } from '../../../helpers/review';

function setup(props: Partial<ComponentProps<typeof Peers>> = {}) {
  const onreject = vi.fn();
  render(Peers, {
    peers: [PEER, SECOND_PEER],
    expiresAt: '2026-11-20T00:00:00.000Z',
    onreject,
    ...props,
  });
  return { onreject };
}

const card = (title: string) =>
  screen.getByRole('heading', { name: title }).closest('li') as HTMLElement;

describe('Peers', () => {
  it('lists peers in the order given, in a disclosure with their count', () => {
    setup();
    expect(screen.getByText('Similar artists (2)')).toBeInTheDocument();
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(['Neon Harbor', 'Quiet Signal']);
  });

  it('labels how each peer was matched and which are secondary', () => {
    setup();
    expect(within(card('Neon Harbor')).getByText('Heard')).toBeInTheDocument();
    expect(within(card('Neon Harbor')).queryByText('Secondary')).toBeNull();
    expect(within(card('Quiet Signal')).getByText('Metadata only')).toBeInTheDocument();
    expect(within(card('Quiet Signal')).getByText('Secondary')).toBeInTheDocument();
  });

  it('shows reported statistics as public reach with the retrieval date', () => {
    setup();
    const peer = card('Neon Harbor');
    expect(within(peer).getByText('Public reach on YouTube')).toBeInTheDocument();
    expect(peer).toHaveTextContent('1,200 subscribers · 40 videos · 90,000 views');
    expect(peer).toHaveTextContent('Oct 20, 2026');
    expect(peer).toHaveTextContent('Same analog synth palette and driving tempo.');
  });

  it('shows a hidden subscriber count as hidden and a missing figure as not reported', () => {
    setup();
    expect(card('Quiet Signal')).toHaveTextContent('hidden subscribers · not reported videos');
  });

  it('shows each release with why it was chosen and calculated engagement', () => {
    setup();
    const link = within(card('Neon Harbor')).getByRole('link', { name: 'Night Drive' });
    expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=v-1');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const line = link.nextElementSibling!;
    expect(line).toHaveTextContent('Most engaged');
    expect(line).toHaveTextContent('1,000 views');
    expect(line).toHaveTextContent('engagement 10.0% (calculated)');
  });

  it('totals nothing across peers', () => {
    setup();
    expect(screen.queryByText(/total|combined|average/i)).toBeNull();
  });

  it('records Not a peer for the one peer clicked', async () => {
    const { onreject } = setup();
    await fireEvent.click(within(card('Quiet Signal')).getByRole('button', { name: 'Not a peer' }));
    expect(onreject).toHaveBeenCalledExactlyOnceWith('P2');
  });

  it('disables Not a peer while busy', () => {
    setup({ busy: true });
    for (const button of screen.getAllByRole('button', { name: 'Not a peer' })) {
      expect(button).toBeDisabled();
    }
  });

  it('says none were used when the list is empty', () => {
    setup({ peers: [] });
    expect(screen.getByText('Similar artists (0)')).toBeInTheDocument();
    expect(screen.getByText('No similar artists were used for this draft.')).toBeInTheDocument();
  });

  it('says the evidence expired, with its date', () => {
    setup({ peers: null });
    expect(screen.getByText('Peer evidence expired on Nov 20, 2026')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not a peer' })).toBeNull();
  });

  it('says it expired without a date when none was recorded', () => {
    setup({ peers: null, expiresAt: null });
    expect(screen.getByText('Peer evidence expired')).toBeInTheDocument();
  });
});

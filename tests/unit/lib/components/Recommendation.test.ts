import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Recommendation from '#lib/components/Recommendation.svelte';
import type { ReviewData } from '#lib/review.js';
import { REVIEW } from '../../../helpers/review';

const setup = (patch: Partial<ReviewData> = {}) =>
  render(Recommendation, { data: { ...REVIEW, ...patch } });

const fact = (term: string) =>
  screen.getByText(term, { selector: 'dt' }).nextElementSibling as HTMLElement;

describe('Recommendation', () => {
  it('shows the approach, aim and what it follows with why', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Recommendation' })).toBeInTheDocument();
    expect(fact('Try')).toHaveTextContent('Open on the chorus.');
    expect(fact('Aim')).toHaveTextContent('More listeners reach the second minute.');
    expect(fact('Follows')).toHaveTextContent('Your own results and similar artists');
    expect(fact('Follows')).toHaveTextContent('Your last release and two peers agree.');
  });

  it.each([
    ['artist', 'Your own results and writing'],
    ['peers', 'Similar artists'],
    ['none', 'Neither: there was too little evidence'],
  ] as const)('names what %s follows', (follows, text) => {
    setup({ recommendation: { ...REVIEW.recommendation!, follows } });
    expect(fact('Follows')).toHaveTextContent(text);
  });

  it('lists the evidence it rests on', () => {
    setup();
    const items = within(fact('Based on')).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Your result: Last Light',
      'P1 · Neon Harbor',
    ]);
  });

  it('says an expired source has expired, with its date', () => {
    setup({
      evidence: [{ ref: 'P1', expired: true, kind: 'peer', expiresAt: '2026-11-20T00:00:00.000Z' }],
    });
    expect(screen.getByText('Peer evidence expired on Nov 20, 2026')).toBeInTheDocument();
  });

  it('turns recorded limits into sentences and shows an unknown one as is', () => {
    setup();
    expect(
      screen.getByText('Your YouTube Analytics results are not shared, so none were used.'),
    ).toBeInTheDocument();
    expect(screen.getByText('something-new')).toBeInTheDocument();
  });

  it('says so when there is no recommendation', () => {
    setup({ recommendation: null, evidence: [] });
    expect(screen.getByText('No recommendation for this draft.')).toBeInTheDocument();
    expect(screen.queryByText('Try', { selector: 'dt' })).toBeNull();
  });

  it('gives the reason when there is no recommendation', () => {
    setup({ recommendation: null, evidence: [], limits: ['secondary-only'] });
    expect(
      screen.getByText('No recommendation: only secondary evidence supported it.'),
    ).toBeInTheDocument();
  });

  it('shows an influence warning', () => {
    setup({ influenceWarning: 'Influence settings not met' });
    expect(screen.getByRole('note')).toHaveTextContent('Influence settings not met');
  });

  it('shows the current and next range', () => {
    setup();
    expect(screen.getByText(/Your range: 100–999 subscribers/)).toHaveTextContent(
      'Next range: 1,000–9,999.',
    );
  });

  it('shows no next range at the top, and no range when unknown', () => {
    const { unmount } = setup({ ranges: { current: 1000000, target: null } });
    expect(screen.getByText(/Your range: 1,000,000 or more/)).not.toHaveTextContent('Next range');
    unmount();
    setup({ ranges: null });
    expect(screen.queryByText(/Your range/)).toBeNull();
  });

  it('lists the influence used per role', () => {
    setup();
    const levels = screen.getByText('Peer influence used').closest('details')!;
    expect(within(levels).getByText('Discovery').nextElementSibling).toHaveTextContent('4 of 4');
    expect(within(levels).getByText('Feel').nextElementSibling).toHaveTextContent('0 of 4');
  });

  it("labels the artist's results and marks the net as calculated", () => {
    setup();
    expect(
      screen.getByRole('heading', { name: 'Your results (YouTube Analytics)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Last Light')).toBeInTheDocument();
    expect(screen.getByText('still collecting', { exact: false })).toBeInTheDocument();
    expect(screen.getByText("on this video's page; a lower bound")).toBeInTheDocument();
    const net = screen.getByText('Net subscribers').nextElementSibling!;
    expect(net).toHaveTextContent('+10');
    expect(net).toHaveTextContent('calculated');
    expect(screen.getByText('Views').nextElementSibling).toHaveTextContent('900');
  });

  it('shows unknown metrics as not reported, never zero', () => {
    setup({
      results: [
        {
          ...REVIEW.results[0]!,
          coverage: 'unknown',
          metrics: { views: null, subscribersGained: null, subscribersLost: 2 },
          net: { value: null, calculated: true },
        },
      ],
    });
    expect(screen.getByText('Views').nextElementSibling).toHaveTextContent('not reported');
    expect(screen.getByText('Net subscribers').nextElementSibling).toHaveTextContent('unknown');
    expect(screen.getByText('may be incomplete', { exact: false })).toBeInTheDocument();
  });

  it('shows no results section without results', () => {
    setup({ results: [] });
    expect(screen.queryByRole('heading', { name: /Your results/ })).toBeNull();
  });
});

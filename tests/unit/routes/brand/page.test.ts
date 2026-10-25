import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Page from '#src/routes/brand/+page.svelte';

const empty = { approved: null, proposal: null, limitUntil: null };
const setup = () => render(Page, { props: { data: { voice: empty, brand: empty } } as never });

describe('brand page', () => {
  it('names the page and holds the voice and brand guide sections', () => {
    setup();
    expect(document.title).toBe('Brand · Soundboard');
    expect(screen.getByRole('heading', { level: 1, name: 'Brand' })).toBeInTheDocument();
    const voice = screen.getByRole('region', { name: 'Voice' });
    const brand = screen.getByRole('region', { name: 'Brand guide' });
    expect(
      within(voice).getByText('Not set. Drafts use plain, generic rules.'),
    ).toBeInTheDocument();
    expect(within(brand).getByText('Not set. Drafts run without one.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Releases' })).toHaveAttribute('href', '/');
  });
});

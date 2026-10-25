import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Page from '#src/routes/settings/+page.svelte';

describe('settings page', () => {
  it('lists every spec 006 role with its default source', () => {
    render(Page);
    expect(screen.getByRole('heading', { level: 1, name: 'Peer influence' })).toBeInTheDocument();
    const defaults = screen.getByRole('region', { name: 'Default sources' });
    const roles = within(defaults)
      .getAllByRole('term')
      .map((term) => term.textContent);
    expect(roles).toEqual(['Sound', 'Feel', 'Wording', 'Discovery', 'Structure']);
    expect(defaults).toHaveTextContent("The artist's own writing and approved edits");
  });

  it('offers nothing to change until the sliders exist', () => {
    render(Page);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'Releases' })).toHaveAttribute('href', '/');
  });
});

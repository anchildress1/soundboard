import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Page from './+page.svelte';

describe('home page', () => {
  it('renders the Soundboard heading', () => {
    render(Page);
    expect(screen.getByRole('heading', { level: 1, name: 'Soundboard' })).toBeInTheDocument();
  });

  it('names the artist it serves', () => {
    render(Page);
    expect(screen.getByText('Release agent · Flies Like Robots')).toBeInTheDocument();
  });
});

import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Footer from '#lib/components/Footer.svelte';

const credit = () => screen.getByRole('contentinfo').querySelector('p')!;

describe('Footer', () => {
  it('credits the artist with a link to their Bandcamp, opening a new tab', () => {
    render(Footer, {
      artist: { name: 'Test Artist', bandcampUrl: 'https://test-artist.bandcamp.com' },
    });
    expect(credit()).toHaveTextContent(
      'Built for Test Artist by Ashley Childress · PolyForm Noncommercial 1.0.0',
    );
    const link = within(credit()).getByRole('link', { name: 'Test Artist' });
    expect(link).toHaveAttribute('href', 'https://test-artist.bandcamp.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'external noopener noreferrer');
  });

  it('names the artist as plain text without a Bandcamp URL', () => {
    render(Footer, { artist: { name: 'Test Artist', bandcampUrl: null } });
    expect(credit()).toHaveTextContent('Built for Test Artist by Ashley Childress');
    expect(within(credit()).queryByRole('link')).toBeNull();
  });

  it('names no artist without a profile', () => {
    render(Footer, { artist: null });
    expect(credit()).toHaveTextContent('Built by Ashley Childress · PolyForm Noncommercial 1.0.0');
    expect(credit()).not.toHaveTextContent('Built for');
  });
});

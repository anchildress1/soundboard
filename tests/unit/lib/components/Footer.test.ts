import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Footer from '#lib/components/Footer.svelte';

const credit = () => screen.getByRole('contentinfo').querySelector('p')!;

describe('Footer', () => {
  it('credits Flies Like Robots with a link to their Bandcamp, opening a new tab', () => {
    render(Footer);
    expect(credit()).toHaveTextContent(
      'Built for Flies Like Robots by Ashley Childress · PolyForm Noncommercial 1.0.0',
    );
    const link = within(credit()).getByRole('link', { name: 'Flies Like Robots' });
    expect(link).toHaveAttribute('href', 'https://flieslikerobots.bandcamp.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'external noopener noreferrer');
  });
});

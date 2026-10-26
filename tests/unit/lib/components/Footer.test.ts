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

  it('shows one icon link per profile, each opening a new tab, then the legal links', () => {
    render(Footer);
    const legal = screen.getByRole('navigation', { name: 'Legal' });
    const social = screen.getByRole('navigation', { name: 'Ashley Childress' });
    expect(social.compareDocumentPosition(legal)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      within(legal)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Terms of Service', 'Privacy policy']);
    const links = within(social).getAllByRole('link');
    expect(links.map((a) => [a.getAttribute('aria-label'), a.getAttribute('href')])).toEqual([
      ['Site', 'https://anchildress1.dev'],
      ['GitHub', 'https://github.com/anchildress1'],
      ['DEV', 'https://dev.to/anchildress1'],
      ['LinkedIn', 'https://www.linkedin.com/in/anchildress1'],
      ['X', 'https://x.com/anchildress1'],
    ]);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'external noopener noreferrer');
      expect(link.querySelector('svg path')?.getAttribute('d')).toBeTruthy();
      expect(link.textContent?.trim()).toBe('');
    }
  });
});

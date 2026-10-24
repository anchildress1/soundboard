import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Terms from '$routes/terms/+page.svelte';

describe('terms of service', () => {
  it('explains content rights, approval and alpha limitations without account controls', () => {
    render(Terms);
    const terms = screen.getByRole('main', { name: 'Terms of Service' });
    expect(terms).toHaveTextContent('You retain your rights');
    expect(terms).toHaveTextContent('Each video and Short requires your approval');
    expect(terms).toHaveTextContent('Uploads are private');
    expect(terms).toHaveTextContent('not a backup service');
    expect(terms).toHaveTextContent('without a promise');
    expect(within(terms).queryByRole('button')).toBeNull();
  });

  it('states that using Soundboard also binds users to YouTube terms', () => {
    render(Terms);
    expect(screen.getByRole('main')).toHaveTextContent(
      'By using Soundboard, you also agree to be bound by the YouTube Terms of Service',
    );
    expect(screen.getByRole('link', { name: 'YouTube Terms of Service' })).toHaveAttribute(
      'href',
      'https://www.youtube.com/t/terms',
    );
  });

  it('links to privacy with a full reload and provides the operator contact', () => {
    render(Terms);
    const privacy = screen.getByRole('link', { name: 'Privacy policy' });
    expect(privacy).toHaveAttribute('href', '/privacy');
    expect(privacy).toHaveAttribute('data-sveltekit-reload');
    expect(screen.getByRole('link', { name: 'anchildress1@gmail.com' })).toHaveAttribute(
      'href',
      'mailto:anchildress1@gmail.com',
    );
  });
});

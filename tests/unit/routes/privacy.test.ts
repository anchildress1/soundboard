import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Privacy from '$routes/privacy/+page.svelte';

describe('privacy policy', () => {
  it('explains data processing and manual deletion without account controls', () => {
    render(Privacy);
    const policy = screen.getByRole('main', { name: 'Privacy policy' });
    expect(policy).toHaveTextContent('Neon stores account, connection, job, and artist-profile');
    expect(policy).toHaveTextContent('Sentry receives error reports and performance traces');
    expect(policy).toHaveTextContent('text prompts, generated responses, and model reasoning');
    expect(policy).toHaveTextContent('within seven calendar days');
    expect(policy).toHaveTextContent('asks Google to revoke');
    expect(within(policy).queryByRole('button')).toBeNull();
  });

  it.each([
    ['Google account permissions', 'https://security.google.com/settings/security/permissions'],
    ['Google Privacy Policy', 'https://policies.google.com/privacy'],
    ['YouTube Terms of Service', 'https://www.youtube.com/t/terms'],
  ])('links to %s', (name, href) => {
    render(Privacy);
    expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
  });

  it('provides the operator contact for questions and deletion requests', () => {
    render(Privacy);
    const contacts = screen.getAllByRole('link', { name: 'anchildress1@gmail.com' });
    expect(contacts).toHaveLength(2);
    for (const contact of contacts) {
      expect(contact).toHaveAttribute('href', 'mailto:anchildress1@gmail.com');
    }
  });
});

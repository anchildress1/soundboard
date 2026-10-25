import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Privacy from '#src/routes/privacy/+page.svelte';

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

  it('discloses what Gemini and Sentry keep without promising zero retention', () => {
    render(Privacy);
    const policy = screen.getByRole('main', { name: 'Privacy policy' });
    expect(policy).toHaveTextContent("paid tier of Google's Gemini API");
    expect(policy).toHaveTextContent('does not use this content to improve its products');
    expect(policy).toHaveTextContent('turns off stored interaction history only');
    expect(policy).toHaveTextContent('does not publish how long those cached copies last');
    expect(policy).toHaveTextContent('up to 55 days to detect abuse');
    expect(policy).toHaveTextContent('Authorized Google staff may review flagged requests');
    expect(policy).toHaveTextContent('Sentry keeps error reports and traces for 30 days');
    expect(policy).toHaveTextContent('cannot reach the copies Google keeps for abuse monitoring');
    expect(policy).not.toHaveTextContent(/self-hosted|zero retention|not retained/i);
  });

  it('discloses peer research, optional analytics and their 29-day deletion', () => {
    render(Privacy);
    const policy = screen.getByRole('main', { name: 'Privacy policy' });
    expect(policy).toHaveTextContent(
      'researches public YouTube channels and videos of similar artists',
    );
    expect(policy).toHaveTextContent('Nothing is added up across channels');
    expect(policy).toHaveTextContent('If you choose Share analytics');
    expect(policy).toHaveTextContent('You can use Soundboard without sharing');
    expect(policy).toHaveTextContent('hidden from the app after 29 days');
    expect(policy).toHaveTextContent('and the analytics results you shared');
    expect(policy).toHaveTextContent('as are the values that came from the YouTube API');
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

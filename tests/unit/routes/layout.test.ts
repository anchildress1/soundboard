import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import Layout from '$routes/+layout.svelte';

type Props = { data: { channel: unknown; session: unknown }; children: unknown };

const children = createRawSnippet(() => ({ render: () => '<main>page body</main>' }));

function setup(data: Partial<Props['data']> = {}) {
  return render(Layout, {
    props: { data: { channel: null, session: null, ...data }, children } as never,
  });
}

const channel = {
  handle: '@flieslikerobots',
  videoCount: 12,
  subscriberCount: 340,
  uploadsPlaylist: 'UUflr',
  lastUploadAt: new Date().toISOString(),
};

describe('layout', () => {
  it('renders the wordmark as a home link with its subtitle', () => {
    setup();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Soundboard');
    expect(screen.getByRole('link', { name: 'Soundboard' })).toHaveAttribute('href', '/');
    expect(screen.getByText('Release agent · Flies Like Robots')).toBeInTheDocument();
  });

  it('renders the page between header and footer', () => {
    setup();
    expect(screen.getByText('page body')).toBeInTheDocument();
    expect(screen.getByText('Built for Nathan. One file in, one upload out.')).toBeInTheDocument();
  });

  it('shows FLR channel stats when available', () => {
    setup({ channel });
    expect(screen.getByText('@flieslikerobots')).toBeInTheDocument();
    expect(screen.getByText(/12 videos · 340 subs/)).toHaveTextContent('last upload today');
  });

  it('omits the last-upload age when unknown', () => {
    setup({ channel: { ...channel, lastUploadAt: null } });
    expect(screen.getByText(/12 videos · 340 subs/).textContent).not.toContain('last upload');
  });

  it('renders without stats', () => {
    setup();
    expect(screen.queryByText(/videos ·/)).toBeNull();
  });

  it('offers sign-in when signed out, with no channel connect links', () => {
    setup();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/login');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.queryByText(/Connect channel/)).toBeNull();
  });

  it('shows the email and sign-out for a non-allowlisted session, still without connect links', () => {
    setup({ session: { email: 'someone@example.com', allowlisted: false } });
    expect(screen.getByText('someone@example.com')).toBeInTheDocument();
    const signOut = screen.getByRole('button', { name: 'Sign out' });
    expect(signOut.closest('form')).toHaveAttribute('action', '/auth/logout');
    expect(signOut.closest('form')).toHaveAttribute('method', 'POST');
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByText(/Connect channel/)).toBeNull();
  });

  it('offers channel connect links to an allowlisted session', () => {
    setup({ session: { email: 'nathan@example.com', allowlisted: true } });
    expect(screen.getByRole('link', { name: 'Nathan' })).toHaveAttribute(
      'href',
      '/auth/login?connect=nathan',
    );
    expect(screen.getByRole('link', { name: 'Sandbox' })).toHaveAttribute(
      'href',
      '/auth/login?connect=sandbox',
    );
  });

  it('never prints "undefined" for a partial stats record', () => {
    setup({ channel: { handle: '@flieslikerobots', lastUploadAt: null } });
    expect(screen.getByText(/videos ·/).textContent).not.toContain('undefined');
  });
});

import { render, screen, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ page: { url: new URL('https://soundboard.test/') } }));
vi.mock('$app/state', () => ({ page: h.page }));

import Layout from '$routes/+layout.svelte';

const HANDLE = '@flieslikerobots';
const NATHAN_EMAIL = 'nathan@example.com';
const STRANGER_EMAIL = 'someone@example.com';
const BRAND_GUIDE = 'Brand guide';

type Props = { data: { channel: unknown; user: unknown }; children: unknown };

const NATHAN = { email: NATHAN_EMAIL, artistId: 'flr' };
const STRANGER = { email: STRANGER_EMAIL, artistId: null };

const children = createRawSnippet(() => ({ render: () => '<main>page body</main>' }));

function setup(data: Partial<Props['data']> = {}) {
  return render(Layout, {
    props: { data: { channel: null, user: null, ...data }, children } as never,
  });
}

const channel = {
  handle: HANDLE,
  videoCount: 12,
  subscriberCount: 340,
  uploadsPlaylist: 'UUflr',
  lastUploadAt: new Date().toISOString(),
};

beforeEach(() => {
  h.page.url = new URL('https://soundboard.test/');
});

describe('layout', () => {
  it('says why a denied sign-in left the visitor signed out', () => {
    h.page.url = new URL('https://soundboard.test/?signin=denied');
    setup();
    expect(screen.getByRole('status')).toHaveTextContent(
      "That Google account isn't invited, so you're still signed out.",
    );
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows no notice on a plain visit', () => {
    setup();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders the wordmark as a home link with its subtitle', () => {
    setup();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Soundboard');
    expect(screen.getByRole('link', { name: 'Soundboard' })).toHaveAttribute('href', '/');
    expect(heading).toHaveTextContent('Flies Like Robots · Release agent');
  });

  it('renders the page between header and footer', () => {
    setup();
    expect(screen.getByText('page body')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      'Built for Flies Like Robots by Ashley Childress Hacktoberfest Weekend Challenge: Build for a Friend',
    );
    expect(screen.getByText('page body').closest('#content')).not.toBeNull();
    const artist = within(screen.getByRole('contentinfo')).getByRole('link', {
      name: 'Flies Like Robots',
    });
    expect(artist).toHaveAttribute('href', 'https://flieslikerobots.bandcamp.com');
    expect(artist).toHaveAttribute('target', '_blank');
  });

  it("links Ashley's site and socials in the footer, opening new tabs", () => {
    setup();
    const nav = screen.getByRole('navigation', { name: 'Ashley Childress' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => [l.getAttribute('aria-label'), l.getAttribute('href')])).toEqual([
      ['anchildress1.dev', 'https://anchildress1.dev'],
      ['GitHub', 'https://github.com/anchildress1'],
      ['DEV', 'https://dev.to/anchildress1'],
      ['LinkedIn', 'https://www.linkedin.com/in/anchildress1'],
      ['X', 'https://x.com/anchildress1'],
    ]);
    for (const link of links) {
      expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(nav.closest('footer')).not.toBeNull();
  });

  it("shows FLR channel stats to Nathan's session", () => {
    setup({ channel, user: NATHAN });
    expect(screen.getByText(HANDLE)).toBeInTheDocument();
    expect(screen.getByText('12 videos · 340 subs')).toBeInTheDocument();
    expect(screen.queryByText(/last upload/)).toBeNull();
  });

  it('renders without stats', () => {
    setup();
    expect(screen.queryByText(/videos ·/)).toBeNull();
  });

  it('offers sign-in when signed out, with no channel connect links', () => {
    setup();
    const signIn = screen.getByRole('link', { name: 'Sign in' });
    expect(signIn).toHaveAttribute('href', '/auth/login');
    expect(signIn).toHaveClass('btn');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.queryByText(/Connect channel/)).toBeNull();
  });

  it('shows the email and sign-out for an unlinked user, without the brand guide', () => {
    setup({ user: STRANGER });
    expect(screen.queryByText(STRANGER_EMAIL)).toBeNull();
    const signOut = screen.getByRole('button', { name: 'Sign out' });
    expect(signOut).toHaveAttribute('title', STRANGER_EMAIL);
    expect(signOut).toHaveClass('btn');
    expect(signOut.closest('form')).toHaveAttribute('action', '/auth/logout');
    expect(signOut.closest('form')).toHaveAttribute('method', 'POST');
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByText(/Connect channel/)).toBeNull();
    expect(screen.queryByRole('link', { name: BRAND_GUIDE })).toBeNull();
  });

  it("gives Nathan's artist the brand guide link, without a sign-in", () => {
    setup({ user: NATHAN });
    const brand = screen.getByRole('link', { name: BRAND_GUIDE });
    expect(brand).toHaveAttribute('href', '/brand');
    expect(brand.closest('header')).not.toBeNull();
    expect(screen.queryByRole('link', { name: /Connect/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });

  it('offers a skip link to the page content', () => {
    setup();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
      'href',
      '#content',
    );
  });

  it('never prints "undefined" for a partial stats record', () => {
    setup({
      channel: { handle: HANDLE, lastUploadAt: null },
      user: NATHAN,
    });
    expect(screen.getByText(/videos ·/).textContent).not.toContain('undefined');
  });
});

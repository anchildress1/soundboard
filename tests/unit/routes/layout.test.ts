import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Layout from '#src/routes/+layout.svelte';

const HANDLE = '@flieslikerobots';
const NATHAN_EMAIL = 'nathan@example.com';
const STRANGER_EMAIL = 'someone@example.com';
const BRAND = 'Brand';

type Props = { data: { channel: unknown; user: unknown; artist: unknown }; children: unknown };

const NATHAN = { email: NATHAN_EMAIL };
const FLR = {
  name: 'Flies Like Robots',
  bandcampUrl: 'https://flieslikerobots.bandcamp.com',
};
const C = { name: 'Test Artist', bandcampUrl: null };
const STRANGER = { email: STRANGER_EMAIL };

const children = createRawSnippet(() => ({ render: () => '<main>page body</main>' }));

function setup(data: Partial<Props['data']> = {}) {
  return render(Layout, {
    props: { data: { channel: null, user: null, artist: null, ...data }, children } as never,
  });
}

const channel = {
  handle: HANDLE,
  videoCount: 12,
  subscriberCount: 340,
  uploadsPlaylist: 'UUflr',
  lastUploadAt: new Date().toISOString(),
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
});

// A closed popover is out of the accessibility tree, so menu queries include hidden elements.
const hidden = { hidden: true } as const;
const menu = () => document.querySelector<HTMLElement>('nav#menu')!;

describe('layout', () => {
  it('renders the wordmark as a home link, leaving the h1 to the page', () => {
    setup();
    expect(screen.getByRole('link', { name: 'Soundboard' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('renders the page between header and footer, naming no artist when signed out', () => {
    setup();
    expect(screen.getByText('page body')).toBeInTheDocument();
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent('Built by Ashley Childress · PolyForm Noncommercial 1.0.0');
    expect(document.body).not.toHaveTextContent('Flies Like Robots');
    expect(screen.getByText('page body').closest('#content')).not.toBeNull();
    const legal = within(footer).getByRole('navigation', { name: 'Legal' });
    const privacy = within(legal).getByRole('link', { name: 'Privacy policy' });
    expect(privacy).toHaveAttribute('href', '/privacy');
    expect(privacy).toHaveAttribute('data-sveltekit-reload');
    const terms = within(legal).getByRole('link', { name: 'Terms of Service' });
    expect(terms).toHaveAttribute('href', '/terms');
    expect(terms).toHaveAttribute('data-sveltekit-reload');
  });

  it("links Ashley's site and socials in the footer, opening new tabs", () => {
    setup();
    const nav = screen.getByRole('navigation', { name: 'Ashley Childress' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Site', 'https://anchildress1.dev'],
      ['GitHub', 'https://github.com/anchildress1'],
      ['DEV', 'https://dev.to/anchildress1'],
      ['LinkedIn', 'https://www.linkedin.com/in/anchildress1'],
      ['X', 'https://x.com/anchildress1'],
    ]);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'external noopener noreferrer');
    }
    expect(nav.closest('footer')).not.toBeNull();
  });

  it('describes the app without naming an artist', () => {
    setup({ user: NATHAN, artist: FLR });
    const meta = document.head.querySelector('meta[name="description"]');
    expect(meta).toHaveAttribute(
      'content',
      'Release agent for musicians: Gemini watches and listens to a music video, then drafts and verifies the YouTube upload.',
    );
  });

  it("shows the connected channel's handle with its exact counts", () => {
    setup({ channel: { ...channel, subscriberCount: 12_345 }, user: NATHAN });
    expect(screen.getByText(HANDLE).closest('header')).not.toBeNull();
    expect(screen.getByText('12 videos · 12,345 subscribers')).toBeInTheDocument();
  });

  it("names the user's artist first in the header row, before the channel", () => {
    setup({ channel, user: STRANGER, artist: C });
    const name = screen.getByText(C.name);
    const row = name.closest('header')!;
    expect(row).not.toBeNull();
    expect(
      name.compareDocumentPosition(screen.getByText(HANDLE)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      'Built for Test Artist by Ashley Childress',
    );
  });

  it('names the artist even without a connected channel', () => {
    setup({ user: STRANGER, artist: C });
    expect(screen.getByText(C.name).closest('header')).not.toBeNull();
  });

  it('counts one video and one subscriber in the singular', () => {
    setup({ channel: { ...channel, videoCount: 1, subscriberCount: 1 }, user: NATHAN });
    expect(screen.getByText('1 video · 1 subscriber')).toBeInTheDocument();
  });

  it('renders without a channel', () => {
    setup({ user: NATHAN });
    expect(screen.queryByText(HANDLE)).toBeNull();
    expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument();
  });

  it('shows no account controls when signed out; sign-in lives on the page', () => {
    setup();
    expect(screen.getByText('Invite only').closest('header')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out', ...hidden })).toBeNull();
    expect(screen.queryByRole('link', { name: /Sign in/, ...hidden })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Connections', ...hidden })).toBeNull();
  });

  it('opens one menu from the header button', () => {
    setup({ user: STRANGER });
    const button = screen.getByRole('button', { name: 'Menu' });
    expect(button).toHaveAttribute('popovertarget', 'menu');
    expect(menu()).toHaveAttribute('aria-label', 'Menu');
    expect(menu()).toHaveAttribute('popover');
  });

  it('gives any user with a profile Connections, Brand, Settings and sign-out', () => {
    setup({ user: STRANGER, artist: C });
    expect(screen.queryByText(STRANGER_EMAIL)).toBeNull();
    const signOut = within(menu()).getByRole('button', { name: 'Sign out', ...hidden });
    expect(signOut).toHaveAttribute('title', STRANGER_EMAIL);
    expect(signOut.closest('form')).toHaveAttribute('action', '/auth/logout');
    expect(signOut.closest('form')).toHaveAttribute('method', 'POST');
    expect(within(menu()).getByRole('link', { name: 'Connections', ...hidden })).toHaveAttribute(
      'href',
      '/connections',
    );
    expect(within(menu()).getByRole('link', { name: BRAND, ...hidden })).toHaveAttribute(
      'href',
      '/brand',
    );
    expect(within(menu()).getByRole('link', { name: 'Settings', ...hidden })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('gives a user with no profile Settings, so they can add one', () => {
    setup({ user: STRANGER });
    expect(within(menu()).getByRole('link', { name: 'Settings', ...hidden })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: BRAND, ...hidden })).toBeNull();
  });

  it("gives Nathan's profile Brand and settings", () => {
    setup({ user: NATHAN, artist: FLR });
    expect(within(menu()).getByRole('link', { name: BRAND, ...hidden })).toHaveAttribute(
      'href',
      '/brand',
    );
    expect(within(menu()).getByRole('link', { name: 'Settings', ...hidden })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('closes the menu when one of its links is followed, not on other clicks', async () => {
    const hidePopover = vi.fn();
    HTMLElement.prototype.hidePopover = hidePopover;
    setup({ user: NATHAN });
    await fireEvent.click(menu()!);
    expect(hidePopover).not.toHaveBeenCalled();
    const link = within(menu()!).getByRole('link', { name: 'Connections', ...hidden });
    // jsdom can't navigate; stop the default so only the menu's handler runs.
    link.addEventListener('click', (event) => event.preventDefault());
    await fireEvent.click(link);
    expect(hidePopover).toHaveBeenCalledOnce();
  });

  it('offers a skip link to the page content', () => {
    setup();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
      'href',
      '#content',
    );
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '#src/routes/connections/+page.svelte';

const nav = vi.hoisted(() => ({ refreshAll: vi.fn() }));
vi.mock('$app/navigation', () => nav);

type Status = 'connected' | 'missing_scopes' | 'no_channel' | 'revoked';
type Notice = 'missing_scopes' | 'no_channel' | 'mismatch' | 'wrong-account' | 'failed';

type AnalyticsNotice = 'shared' | 'declined';

const setup = (
  youtube: {
    status: Status;
    channelTitle: string | null;
    channelId?: string | null;
    analytics?: boolean;
  } | null,
  notice: Notice | null = null,
  analyticsNotice: AnalyticsNotice | null = null,
) =>
  render(Page, {
    props: {
      data: {
        youtube: youtube && { analytics: false, ...youtube },
        notice,
        analyticsNotice,
      },
    } as never,
  });

const CHANNEL_URL = 'https://www.youtube.com/channel/UCflr';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  nav.refreshAll.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const reconnectForm = (name: string) => {
  const form = screen.getByRole('button', { name }).closest('form')!;
  expect(form).toHaveAttribute('action', '/auth/login');
  expect(form).toHaveAttribute('method', 'GET');
  expect(form).toHaveAttribute('data-sveltekit-reload');
  expect(new FormData(form).get('connect')).toBe('youtube');
};

describe('connections page', () => {
  it('shows the connected channel with Disconnect, and no reconnect', () => {
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' });
    expect(screen.getByRole('heading', { name: 'YouTube' })).toBeInTheDocument();
    expect(screen.getByText('Connected to Flies Like Robots.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('links the connected channel to YouTube in a new tab', () => {
    setup({ status: 'connected', channelTitle: 'Flies Like Robots', channelId: 'UCflr' });
    const link = screen.getByRole('link', { name: 'Flies Like Robots' });
    expect(link).toHaveAttribute('href', CHANNEL_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('links an untitled channel as "your channel"', () => {
    setup({ status: 'connected', channelTitle: null, channelId: 'UCflr' });
    expect(screen.getByRole('link', { name: 'your channel' })).toHaveAttribute('href', CHANNEL_URL);
  });

  it('names the channel without a link when its ID is unknown', () => {
    setup({ status: 'connected', channelTitle: 'Flies Like Robots', channelId: null });
    expect(screen.getByText('Connected to Flies Like Robots.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Flies Like Robots' })).toBeNull();
  });

  it.each<[Status, string]>([
    ['missing_scopes', 'Upload and read access are missing. Reconnect and allow both.'],
    ['no_channel', 'This Google account has no YouTube channel. Create one, then reconnect.'],
    ['revoked', 'Access was removed. Reconnect to keep uploading.'],
  ])('shows %s with its fix line and Reconnect', (status, line) => {
    setup({ status, channelTitle: null });
    expect(screen.getByText(line)).toBeInTheDocument();
    reconnectForm('Reconnect');
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('lists Bandcamp and later platforms with nothing to operate', () => {
    setup(null);
    expect(screen.getByRole('heading', { name: 'Bandcamp' })).toBeInTheDocument();
    expect(screen.getByText('Nothing to connect')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Instagram · TikTok' })).toBeInTheDocument();
    expect(screen.getByText('Coming later')).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Connect']);
  });

  it('links back to releases', () => {
    setup(null);
    expect(screen.getByRole('link', { name: 'Releases' })).toHaveAttribute('href', '/');
  });

  it('offers Connect with no connection', () => {
    setup(null);
    expect(screen.getByText('Not connected.')).toBeInTheDocument();
    reconnectForm('Connect');
  });

  it.each<[Notice, string]>([
    ['missing_scopes', "Google didn't grant upload and read access. Reconnect and allow both."],
    ['no_channel', 'That Google account has no YouTube channel. Create one, then reconnect.'],
    ['mismatch', 'That connection attempt expired or started in another session. Try again.'],
    ['wrong-account', 'Connect YouTube with the Google account you signed in with.'],
    ['failed', "Couldn't connect YouTube. Try again."],
  ])('explains the %s callback outcome', (notice, line) => {
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' }, notice);
    expect(screen.getByRole('status')).toHaveTextContent(line);
  });

  it('says analytics is not shared and links Share analytics to the consent flow', () => {
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' });
    expect(screen.getByText(/Analytics: Not shared/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Share analytics' });
    expect(link).toHaveAttribute('href', '/auth/login?connect=analytics');
    expect(link).toHaveAttribute('data-sveltekit-reload');
    expect(
      screen.getByText(
        'Stop sharing by disconnecting YouTube; Soundboard deletes your stored results.',
      ),
    ).toBeInTheDocument();
  });

  it('says analytics is shared and offers no second consent', () => {
    setup({ status: 'connected', channelTitle: 'Flies Like Robots', analytics: true });
    expect(screen.getByText(/Analytics: Shared/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Share analytics' })).toBeNull();
    expect(screen.getByText(/Stop sharing by disconnecting YouTube/)).toBeInTheDocument();
  });

  it('hides the analytics line while YouTube is not connected', () => {
    setup({ status: 'revoked', channelTitle: null });
    expect(screen.queryByText(/Analytics:/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Share analytics' })).toBeNull();
  });

  it.each<[AnalyticsNotice, string]>([
    ['shared', 'Analytics shared. The next draft can learn from your own results.'],
    ['declined', "Analytics wasn't shared. Drafts keep working without it."],
  ])('explains the %s analytics outcome', (analyticsNotice, line) => {
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' }, null, analyticsNotice);
    expect(screen.getByRole('status')).toHaveTextContent(line);
  });

  it('shows no notice by default', () => {
    setup(null);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('disconnects, then reloads the page data', async () => {
    fetchMock.mockResolvedValue(Response.json({ revokedAtGoogle: true }));
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' });
    await fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(nav.refreshAll).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/connections/youtube/disconnect',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.queryByText(/Google didn't confirm/)).toBeNull();
  });

  it('says where to finish when Google did not confirm the revoke', async () => {
    fetchMock.mockResolvedValue(Response.json({ revokedAtGoogle: false }));
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' });
    await fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(
      await screen.findByText(
        "Removed here. Google didn't confirm. Remove Soundboard at myaccount.google.com/permissions.",
      ),
    ).toBeInTheDocument();
    expect(nav.refreshAll).toHaveBeenCalledOnce();
  });

  it('disables Disconnect while the request is in flight', async () => {
    let answer: (response: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' });
    const button = screen.getByRole('button', { name: 'Disconnect' });
    await fireEvent.click(button);
    expect(button).toBeDisabled();
    answer(Response.json({ revokedAtGoogle: true }));
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('says why a disconnect failed and keeps the row', async () => {
    fetchMock.mockResolvedValue(Response.json({ message: 'Sign in first.' }, { status: 401 }));
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' });
    await fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Sign in first.')).toBeInTheDocument();
    expect(nav.refreshAll).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  });

  it('falls back to a plain message for a non-Error failure', async () => {
    fetchMock.mockRejectedValue('offline');
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' });
    await fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Disconnect failed')).toBeInTheDocument();
  });
});

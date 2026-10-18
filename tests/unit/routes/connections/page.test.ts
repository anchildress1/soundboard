import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '$routes/connections/+page.svelte';

const nav = vi.hoisted(() => ({ invalidateAll: vi.fn() }));
vi.mock('$app/navigation', () => nav);

type Status = 'connected' | 'missing_scopes' | 'no_channel' | 'revoked';
type Notice = 'missing_scopes' | 'no_channel' | 'mismatch' | 'wrong-account';

const setup = (
  youtube: { status: Status; channelTitle: string | null } | null,
  notice: Notice | null = null,
) => render(Page, { props: { data: { youtube, notice } } as never });

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  nav.invalidateAll.mockReset();
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

  it('names no channel when the title is unknown', () => {
    setup({ status: 'connected', channelTitle: null });
    expect(screen.getByText('Connected to your channel.')).toBeInTheDocument();
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

  it('offers Connect with no connection', () => {
    setup(null);
    expect(screen.getByText('Not connected.')).toBeInTheDocument();
    reconnectForm('Connect');
  });

  it.each<[Notice, string]>([
    ['missing_scopes', "Google didn't grant upload and read access. Reconnect and allow both."],
    ['no_channel', 'That Google account has no YouTube channel. Create one, then reconnect.'],
    ['mismatch', 'That connect expired or started in another session. Try again.'],
    ['wrong-account', 'Connect YouTube with the Google account you signed in with.'],
  ])('explains the %s callback outcome', (notice, line) => {
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' }, notice);
    expect(screen.getByRole('status')).toHaveTextContent(line);
  });

  it('shows no notice by default', () => {
    setup(null);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('disconnects, then reloads the page data', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' });
    await fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/connections/youtube/disconnect',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('says why a disconnect failed and keeps the row', async () => {
    fetchMock.mockResolvedValue(Response.json({ message: 'Sign in first.' }, { status: 401 }));
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' });
    await fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Sign in first.')).toBeInTheDocument();
    expect(nav.invalidateAll).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  });

  it('falls back to a plain message for a non-Error failure', async () => {
    fetchMock.mockRejectedValue('offline');
    setup({ status: 'connected', channelTitle: 'Flies Like Robots' });
    await fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Disconnect failed')).toBeInTheDocument();
  });
});

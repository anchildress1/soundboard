import { render, screen, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '$routes/+page.svelte';

const h = vi.hoisted(() => ({ page: { url: new URL('https://soundboard.test/') } }));

vi.mock('$app/state', () => ({ page: h.page }));

const USER = { email: 'b@example.com', artistId: null };
const START = /Start a new release/;

type ListedJob = { id: string; songTitle: string; state: string; createdAt: number };

const job = (id: string, songTitle: string, state: string): ListedJob => ({
  id,
  songTitle,
  state,
  createdAt: 1,
});

function setup(user: typeof USER | null = USER, jobs: ListedJob[] = []) {
  return render(Page, { props: { data: { user, channel: null, jobs } } as never });
}

beforeEach(() => {
  h.page.url = new URL('https://soundboard.test/');
});

describe('home page: signed out', () => {
  it('is a sign-in view with one Google action and no release controls', () => {
    setup(null);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in to Soundboard');
    const signIn = screen.getByRole('link', { name: 'Continue with Google' });
    expect(signIn).toHaveAttribute('href', '/auth/login');
    expect(signIn).toHaveAttribute('data-sveltekit-reload');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.queryByRole('link', { name: START })).toBeNull();
  });

  it('shows the not-invited notice from the callback', () => {
    h.page.url = new URL('https://soundboard.test/?signin=denied');
    setup(null);
    expect(screen.getByRole('status')).toHaveTextContent("That Google account isn't invited");
  });
});

describe('home page: first release', () => {
  it('explains the loop and starts the first release', () => {
    setup();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Upload your first video');
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByRole('link', { name: 'Start' })).toHaveAttribute('href', '/new');
    expect(screen.queryByRole('region', { name: 'Earlier' })).toBeNull();
  });
});

describe('home page: releases', () => {
  it('puts the newest release that needs review up next, with one Continue', () => {
    setup(USER, [
      job('j3', 'Paper Satellites', 'ANALYZE'),
      job('j2', 'Static Bloom', 'REVIEW'),
      job('j1', 'Half Light', 'REVIEW'),
    ]);
    const next = screen.getByRole('region', { name: 'Review the draft for Static Bloom' });
    expect(within(next).getByRole('link', { name: 'Continue Static Bloom' })).toHaveAttribute(
      'href',
      '/jobs/j2',
    );
    expect(within(next).getByRole('link')).toHaveClass('primary');
    // The older review waits in the list, still marked as needing the user.
    const earlier = screen.getByRole('region', { name: 'Earlier' });
    expect(within(earlier).getByText('Half Light')).toBeInTheDocument();
    expect(within(earlier).getByText('Needs your review')).toBeInTheDocument();
  });

  it('keeps New release secondary while something is up next', () => {
    setup(USER, [job('j2', 'Static Bloom', 'REVIEW')]);
    expect(screen.getByRole('link', { name: START })).not.toHaveClass('primary');
    expect(screen.getByRole('link', { name: START })).toHaveAttribute('href', '/new');
  });

  it('makes New release the primary action when nothing needs the user', () => {
    setup(USER, [job('j1', 'Half Light', 'VERIFIED')]);
    expect(screen.queryByRole('region', { name: /Review the draft/ })).toBeNull();
    expect(screen.getByRole('link', { name: START })).toHaveClass('primary');
  });

  it('shows running releases with nothing to do yet and a Watch link', () => {
    setup(USER, [job('j3', 'Paper Satellites', 'ANALYZE'), job('j4', 'Low Orbit', 'PUBLISHING')]);
    const running = screen.getByRole('region', { name: 'Paper Satellites' });
    expect(running).toHaveTextContent('Listening · nothing to do yet');
    expect(within(running).getByRole('link', { name: 'Watch Paper Satellites' })).toHaveAttribute(
      'href',
      '/jobs/j3',
    );
    expect(screen.getByRole('region', { name: 'Low Orbit' })).toHaveTextContent(
      'Uploading to YouTube',
    );
    expect(screen.queryByRole('region', { name: 'Earlier' })).toBeNull();
  });

  it('sends a browser upload back to its page instead of saying to wait', () => {
    setup(USER, [job('j5', 'Night Bus', 'AWAITING_UPLOAD')]);
    const running = screen.getByRole('region', { name: 'Night Bus' });
    expect(running).toHaveTextContent('Uploading · open it to finish the upload');
    expect(running).not.toHaveTextContent('nothing to do yet');
    expect(within(running).getByRole('link', { name: 'Open Night Bus' })).toHaveAttribute(
      'href',
      '/jobs/j5',
    );
  });

  it('lists finished, failed, and discarded releases under Earlier with their state', () => {
    setup(USER, [
      job('j1', 'Half Light', 'VERIFIED'),
      job('j2', 'Mr. Kill', 'FAILED'),
      job('j3', 'Gone', 'DISCARDED'),
    ]);
    const rows = within(screen.getByRole('region', { name: 'Earlier' })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Half Light Verified · private Open',
      'Mr. Kill Failed Open',
      'Gone Discarded Open',
    ]);
    expect(screen.getByRole('link', { name: 'Open Mr. Kill' })).toHaveAttribute('href', '/jobs/j2');
    expect(rows[1]!.querySelector('.dot')).toHaveAttribute('data-tone', 'err');
  });
});

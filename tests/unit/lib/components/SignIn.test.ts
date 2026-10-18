import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ page: { url: new URL('https://soundboard.test/') } }));
vi.mock('$app/state', () => ({ page: h.page }));

import SignIn from '$lib/components/SignIn.svelte';

const visit = (query = '') => {
  h.page.url = new URL(`https://soundboard.test/${query}`);
  return render(SignIn);
};

beforeEach(() => {
  h.page.url = new URL('https://soundboard.test/');
});

describe('SignIn', () => {
  it('offers one Google sign-in link, loaded as a full page', () => {
    visit();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName('Sign in with Google');
    expect(links[0]).toHaveAttribute('href', '/auth/login');
    expect(links[0]).toHaveAttribute('data-sveltekit-reload');
  });

  it('shows no notice on a plain visit', () => {
    visit();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says an uninvited account was turned away', () => {
    visit('?signin=denied');
    expect(screen.getByRole('status')).toHaveTextContent("That Google account isn't invited.");
  });

  it('says an expired sign-in should be retried', () => {
    visit('?signin=expired');
    expect(screen.getByRole('status')).toHaveTextContent('Sign-in expired. Try again.');
  });

  it.each(['?signin=other', '?signin=', '?signin=constructor'])(
    'ignores an unknown notice (%s)',
    (query) => {
      visit(query);
      expect(screen.queryByRole('status')).toBeNull();
    },
  );
});

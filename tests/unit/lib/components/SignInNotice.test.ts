import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ page: { url: new URL('https://soundboard.test/') } }));
vi.mock('$app/state', () => ({ page: h.page }));

import SignInNotice from '#lib/components/SignInNotice.svelte';

const visit = (query = '') => {
  h.page.url = new URL(`https://soundboard.test/${query}`);
  return render(SignInNotice);
};

beforeEach(() => {
  h.page.url = new URL('https://soundboard.test/');
});

describe('SignInNotice', () => {
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

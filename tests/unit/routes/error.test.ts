import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  page: { status: 404, error: null as { message: string } | null },
}));
vi.mock('$app/state', () => ({ page: h.page }));

import ErrorPage from '$routes/+error.svelte';

beforeEach(() => {
  h.page.status = 404;
  h.page.error = { message: 'Not Found' };
});

describe('error page', () => {
  it('explains a 404 and links home', () => {
    render(ErrorPage);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText('404')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Soundboard' })).toHaveAttribute('href', '/');
    expect(screen.queryByText('Not Found')).toBeNull();
  });

  it("shows the server's message for other errors", () => {
    h.page.status = 500;
    h.page.error = { message: 'Firestore is down' };
    render(ErrorPage);
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByText('Firestore is down')).toBeInTheDocument();
  });

  it('falls back to a plain message when the error has none', () => {
    h.page.status = 500;
    h.page.error = null;
    render(ErrorPage);
    expect(screen.getByText('The server hit an error.')).toBeInTheDocument();
  });
});

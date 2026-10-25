import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ReleaseBar from '#lib/components/ReleaseBar.svelte';

const rail = (container: HTMLElement) => [...container.querySelectorAll('.rail li')];

describe('ReleaseBar', () => {
  it('names the step and links back home with the song', () => {
    render(ReleaseBar, { title: 'PeekaBoo', step: 2 });
    expect(screen.getByText('Step 3 of 8 · Title')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to releases from PeekaBoo' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(screen.getByRole('link', { name: 'Save & leave' })).toHaveAttribute('href', '/');
  });

  it.each([
    ['before anything is saved', 0],
    ['once done', 8],
    ['for a stopped release', -1],
  ])('offers no Save & leave %s', (_, step) => {
    render(ReleaseBar, { title: 'PeekaBoo', step });
    expect(screen.queryByRole('link', { name: 'Save & leave' })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Back to releases from PeekaBoo' }),
    ).toBeInTheDocument();
  });

  it('lights the steps before the current one and marks the current one', () => {
    const { container } = render(ReleaseBar, { title: 'PeekaBoo', step: 2 });
    const steps = rail(container);
    expect(steps).toHaveLength(8);
    expect(steps.map((li) => li.classList.contains('done'))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(steps.findIndex((li) => li.classList.contains('current'))).toBe(2);
    // The rail repeats the label, so screen readers skip it.
    expect(container.querySelector('.rail')).toHaveAttribute('aria-hidden', 'true');
  });

  it('reads Done with every step lit past the end', () => {
    const { container } = render(ReleaseBar, { title: 'PeekaBoo', step: 8 });
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(rail(container).every((li) => li.classList.contains('done'))).toBe(true);
    expect(container.querySelector('.rail .current')).toBeNull();
  });

  it('reads Stopped with nothing lit for a stopped release', () => {
    const { container } = render(ReleaseBar, { title: 'PeekaBoo', step: -1 });
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(container.querySelector('.rail .done, .rail .current')).toBeNull();
  });

  it('takes a label for side trips', () => {
    render(ReleaseBar, { title: 'PeekaBoo', step: 8, label: 'Short' });
    expect(screen.getByText('Short')).toBeInTheDocument();
    expect(screen.queryByText('Done')).toBeNull();
  });
});

import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import JobList from '#lib/components/JobList.svelte';
import type { JobState } from '#lib/types.js';

const job = (id: string, songTitle: string, state: JobState) => ({ id, songTitle, state });

describe('JobList', () => {
  it('lists each job with its title, plain state and a continue link, in the given order', () => {
    render(JobList, {
      jobs: [job('j2', 'PeekaBoo', 'REVIEW'), job('j1', 'Vaporgram', 'VERIFIED')],
    });
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items.map((li) => li.textContent?.replaceAll(/\s+/g, ' ').trim())).toEqual([
      'PeekaBoo Needs review Continue',
      'Vaporgram Verified · private Continue',
    ]);
    expect(screen.getByRole('link', { name: 'Continue PeekaBoo' })).toHaveAttribute(
      'href',
      '/jobs/j2',
    );
    expect(screen.getByRole('heading', { name: 'Your runs' })).toBeInTheDocument();
  });

  it('renders nothing when there are no jobs', () => {
    const { container } = render(JobList, { jobs: [] });
    expect(container.querySelector('section')).toBeNull();
  });
});

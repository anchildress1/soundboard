import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import JobList from '$lib/components/JobList.svelte';
import type { JobState } from '$lib/types';

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

  it.each([
    ['AWAITING_UPLOAD', 'Uploading'],
    ['ANALYZE', 'Analyzing'],
    ['PUBLISHING', 'Uploading to YouTube'],
    ['FAILED', 'Failed'],
    ['DISCARDED', 'Discarded'],
  ] as const)('labels %s as "%s"', (state, label) => {
    render(JobList, { jobs: [job('j', 'PeekaBoo', state)] });
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('renders nothing when there are no jobs', () => {
    const { container } = render(JobList, { jobs: [] });
    expect(container.querySelector('section')).toBeNull();
  });

  it('keeps a title with markup as text', () => {
    render(JobList, { jobs: [job('j', '<b>Loud</b>', 'REVIEW')] });
    expect(screen.getByText('<b>Loud</b>')).toBeInTheDocument();
  });
});

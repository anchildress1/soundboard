import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Payload from '$lib/components/Payload.svelte';

describe('Payload', () => {
  it('shows the would-be videos.insert body: private, not made for kids, Music category', () => {
    render(Payload, {
      fields: {
        title: 'PeekaBoo',
        description: 'd #synthwave',
        hashtags: ['#synthwave'],
        tags: ['synthwave'],
      },
    });
    const region = screen.getByRole('region', { name: 'Would-be upload payload' });
    const body = JSON.parse(region.querySelector('pre')!.textContent!) as unknown;
    expect(body).toEqual({
      snippet: {
        title: 'PeekaBoo',
        description: 'd #synthwave',
        tags: ['synthwave'],
        categoryId: '10',
      },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
    });
    expect(screen.getByRole('heading', { name: 'Would-be payload' })).toBeInTheDocument();
  });

  it('renders empty tags as an empty list', () => {
    render(Payload, { fields: { title: 't', description: '', hashtags: [], tags: [] } });
    expect(screen.getByText(/"tags": \[\]/)).toBeInTheDocument();
  });
});

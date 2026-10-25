import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Bandcamp from '#lib/components/Bandcamp.svelte';
import type { Pick } from '#lib/types.js';

const ABOUT = 'A terminal screen and some noise.';
const FLR_URL = 'https://flieslikerobots.bandcamp.com';
const COPY_ABOUT = 'Copy About';

const pick: Pick = {
  version: 1,
  title: 'Vaporgram - Flies Like Robots',
  description: 'Vaporgram by Flies Like Robots',
  hashtags: ['#vaporwave'],
  tags: ['vaporwave', 'glitch', 'Flies Like Robots'],
  flags: [],
  brandCheck: '',
  why: { title: '', description: '', tags: '' },
  bandcamp: {
    about: ABOUT,
    credits: 'Written, performed, recorded, hacked and slashed by Nathan.',
  },
  artistName: 'Flies Like Robots',
  modelMs: 1,
};

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  localStorage.clear();
  writeText.mockReset().mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

const field = (label: string) => screen.getByText(label, { selector: 'dt' }).closest('.field')!;

describe('Bandcamp', () => {
  it('shows the track name, about, credits, and tags for the editor', () => {
    render(Bandcamp, {
      jobId: 'j1',
      bandcampUrl: FLR_URL,
      songTitle: 'Vaporgram',
      tags: pick.tags,
      pick,
    });
    expect(within(field('Track name') as HTMLElement).getByText('Vaporgram')).toBeInTheDocument();
    expect(screen.getByText(ABOUT)).toBeInTheDocument();
    expect(screen.getByText(/hacked and slashed by Nathan/)).toBeInTheDocument();
    expect(screen.getByText('vaporwave, glitch, Flies Like Robots')).toBeInTheDocument();
  });

  it('offers the tags it is given, not the pick draft, so edits reach Bandcamp', () => {
    render(Bandcamp, {
      jobId: 'j1',
      bandcampUrl: FLR_URL,
      songTitle: 'Vaporgram',
      tags: ['vaporwave'],
      pick,
    });
    expect(within(field('Tags') as HTMLElement).getByText('vaporwave')).toBeInTheDocument();
    expect(screen.queryByText(/glitch/)).toBeNull();
  });

  it('marks itself done once every field is copied, and remembers it per pick', async () => {
    let done = false;
    const props = {
      jobId: 'j1',
      bandcampUrl: FLR_URL,
      songTitle: 'Vaporgram',
      tags: pick.tags,
      ondone: (value: boolean) => (done = value),
      pick,
    };
    const { unmount } = render(Bandcamp, props);
    for (const label of ['Track name', 'About', 'Credits']) {
      await fireEvent.click(screen.getByRole('button', { name: `Copy ${label}` }));
    }
    expect(done).toBe(false);
    await fireEvent.click(screen.getByRole('button', { name: 'Copy Tags' }));
    expect(done).toBe(true);
    unmount();
    render(Bandcamp, props);
    expect(screen.getByRole('button', { name: 'Copy Tags' })).toHaveTextContent('Copied');
  });

  it('opens the editor in its own window, falling back to a tab when popups are blocked', async () => {
    const popup = { opener: {} as unknown, location: { href: '' } };
    const open = vi.spyOn(window, 'open').mockReturnValueOnce(popup as unknown as Window);
    render(Bandcamp, {
      jobId: 'j1',
      bandcampUrl: FLR_URL,
      songTitle: 'Vaporgram',
      tags: pick.tags,
      pick,
    });
    const link = screen.getByRole('link', { name: "Open Bandcamp's new-track page" });
    const opened = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(opened);
    expect(open).toHaveBeenCalledWith('', 'bandcamp', 'popup,width=1200,height=900');
    // The opener is cut before Bandcamp loads, so its page can't reach back into Soundboard.
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toBe('https://flieslikerobots.bandcamp.com/edit_track');
    expect(opened.defaultPrevented).toBe(true);
    open.mockReturnValueOnce(null);
    const blocked = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(false);
    open.mockRestore();
  });

  it("opens Bandcamp's new-track page in a new tab", () => {
    render(Bandcamp, {
      jobId: 'j1',
      bandcampUrl: FLR_URL,
      songTitle: 'Vaporgram',
      tags: pick.tags,
      pick,
    });
    const open = screen.getByRole('link', { name: "Open Bandcamp's new-track page" });
    expect(open).toHaveAttribute('href', 'https://flieslikerobots.bandcamp.com/edit_track');
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'external noopener noreferrer');
  });

  it("links the profile's own editor", () => {
    render(Bandcamp, {
      jobId: 'j1',
      bandcampUrl: 'https://test-artist.bandcamp.com',
      songTitle: 'Vaporgram',
      tags: pick.tags,
      pick,
    });
    expect(screen.getByRole('link', { name: "Open Bandcamp's new-track page" })).toHaveAttribute(
      'href',
      'https://test-artist.bandcamp.com/edit_track',
    );
  });

  it('points to Settings instead of an editor when the profile has no Bandcamp URL', () => {
    render(Bandcamp, {
      jobId: 'j1',
      bandcampUrl: null,
      songTitle: 'Vaporgram',
      tags: pick.tags,
      pick,
    });
    expect(screen.queryByRole('link', { name: "Open Bandcamp's new-track page" })).toBeNull();
    expect(screen.getByRole('link', { name: 'Add your Bandcamp URL in Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.getByRole('button', { name: COPY_ABOUT })).toBeEnabled();
  });

  it('copies one field and says so', async () => {
    render(Bandcamp, {
      jobId: 'j1',
      bandcampUrl: FLR_URL,
      songTitle: 'Vaporgram',
      tags: pick.tags,
      pick,
    });
    await fireEvent.click(screen.getByRole('button', { name: COPY_ABOUT }));
    expect(writeText).toHaveBeenCalledWith(ABOUT);
    expect(screen.getByRole('button', { name: COPY_ABOUT })).toHaveTextContent('Copied');
    expect(screen.getByRole('button', { name: 'Copy Credits' })).toHaveTextContent('Copy');
    expect(screen.getByText('About copied')).toBeInTheDocument();
  });

  it('shows no copied state when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(Bandcamp, {
      jobId: 'j1',
      bandcampUrl: FLR_URL,
      songTitle: 'Vaporgram',
      tags: pick.tags,
      pick,
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy Tags' }));
    expect(screen.getByRole('button', { name: 'Copy Tags' })).toHaveTextContent('Copy');
    expect(screen.queryByText(/copied$/)).toBeNull();
  });

  it('asks for a new copy when an approved edit changes the value', async () => {
    const props = {
      jobId: 'j1',
      bandcampUrl: FLR_URL,
      songTitle: 'Vaporgram',
      tags: ['vaporwave'],
      pick,
    };
    const { unmount } = render(Bandcamp, props);
    await fireEvent.click(screen.getByRole('button', { name: 'Copy Tags' }));
    expect(screen.getByRole('button', { name: 'Copy Tags' })).toHaveTextContent('Copied');
    unmount();
    render(Bandcamp, { ...props, tags: ['vaporwave', 'glitch'] });
    expect(screen.getByRole('button', { name: 'Copy Tags' })).toHaveTextContent('Copy');
  });

  it('ignores a checklist stored in an unexpected shape', () => {
    localStorage.setItem('bandcamp:j1:1', JSON.stringify(['Tags']));
    render(Bandcamp, {
      jobId: 'j1',
      bandcampUrl: FLR_URL,
      songTitle: 'Vaporgram',
      tags: pick.tags,
      pick,
    });
    expect(screen.getByRole('button', { name: 'Copy Tags' })).toHaveTextContent('Copy');
  });

  it('disables copying an empty field', () => {
    render(Bandcamp, {
      jobId: 'j1',
      bandcampUrl: FLR_URL,
      songTitle: 'Vaporgram',
      pick: { ...pick, bandcamp: { about: '', credits: 'x' } },
      tags: pick.tags,
    });
    expect(screen.getByRole('button', { name: COPY_ABOUT })).toBeDisabled();
  });
});

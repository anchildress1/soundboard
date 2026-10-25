import type { ComponentProps } from 'svelte';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '#src/routes/settings/+page.svelte';
import { ARTIST_C } from '../../../helpers/pipeline';

type PageData = ComponentProps<typeof Page>['data'];

const h = vi.hoisted(() => ({ invalidateAll: vi.fn() }));
vi.mock('$app/navigation', () => ({ invalidateAll: h.invalidateAll }));

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const C = {
  name: ARTIST_C.name,
  bandcampUrl: ARTIST_C.bandcampUrl,
  contactLine: ARTIST_C.contactLine,
};
const renderPage = (artist: PageData['artist'] = C) =>
  render(Page, { data: { artist } as PageData });

beforeEach(() => {
  h.invalidateAll.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('settings page', () => {
  it('pre-fills the artist section above peer influence', () => {
    renderPage();
    expect(document.title).toBe('Settings · Soundboard');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    const artist = screen.getByRole('form', { name: 'Artist' });
    expect(within(artist).getByLabelText('Artist name')).toHaveValue(ARTIST_C.name);
    expect(within(artist).getByLabelText(/^Bandcamp URL/)).toHaveValue(ARTIST_C.bandcampUrl);
    expect(within(artist).getByLabelText(/^Contact line/)).toHaveValue(ARTIST_C.contactLine);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h2) => h2.textContent);
    expect(headings.indexOf('Artist')).toBeLessThan(headings.indexOf('Peer influence'));
  });

  it('saves a rename with the other fields as stored, then says so and reloads the data', async () => {
    fetchMock.mockResolvedValue(json({ artist: { ...C, name: 'Renamed Band' } }));
    renderPage();
    await fireEvent.input(screen.getByLabelText('Artist name'), {
      target: { value: 'Renamed Band' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const [path, init] = fetchMock.mock.calls[0]!;
    expect([path, init?.method]).toEqual(['/api/artist', 'PUT']);
    expect(JSON.parse(String(init?.body))).toEqual({ ...C, name: 'Renamed Band' });
    expect(h.invalidateAll).toHaveBeenCalledOnce();
  });

  it('lists every spec 006 role with its default source', () => {
    renderPage();
    const defaults = screen.getByRole('region', { name: 'Default sources' });
    const roles = within(defaults)
      .getAllByRole('term')
      .map((term) => term.textContent);
    expect(roles).toEqual(['Sound', 'Feel', 'Wording', 'Discovery', 'Structure']);
    expect(defaults).toHaveTextContent("The artist's own writing and approved edits");
  });

  it('has no sliders yet, and links home', () => {
    renderPage();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('link', { name: 'Releases' })).toHaveAttribute('href', '/');
  });
});

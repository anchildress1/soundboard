import type { ComponentProps } from 'svelte';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '#src/routes/settings/+page.svelte';
import { DEFAULT_INFLUENCE } from '#lib/influence.js';
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
const renderPage = (artist: PageData['artist'] = C, canSave = true) =>
  render(Page, {
    data: { artist, influence: DEFAULT_INFLUENCE, saved: false, canSave } as PageData,
  });

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

  it('shows a slider per role at its default, with the role’s default source', () => {
    renderPage();
    const influence = screen.getByRole('form', { name: 'Peer influence' });
    const sliders = within(influence).getAllByRole('slider');
    expect(sliders.map((s) => s.getAttribute('id'))).toEqual([
      'influence-sound',
      'influence-feel',
      'influence-wording',
      'influence-discovery',
      'influence-structure',
    ]);
    expect(sliders.map((s) => (s as HTMLInputElement).value)).toEqual(['1', '0', '0', '4', '4']);
    expect(influence).toHaveTextContent('The mood and tone');
  });

  it('saves the sliders, then says so and reloads the data', async () => {
    fetchMock.mockResolvedValue(json({ influence: { ...DEFAULT_INFLUENCE, feel: 2 } }));
    renderPage();
    await fireEvent.input(screen.getByRole('slider', { name: /^Feel/ }), {
      target: { value: '2' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const [path, init] = fetchMock.mock.calls[0]!;
    expect([path, init?.method]).toEqual(['/api/influence', 'PUT']);
    expect(JSON.parse(String(init?.body))).toEqual({ ...DEFAULT_INFLUENCE, feel: 2 });
    expect(h.invalidateAll).toHaveBeenCalledOnce();
  });

  it('disables saving the sliders until a brand guide is approved', () => {
    renderPage(C, false);
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Brand' })).toHaveAttribute('href', '/brand');
  });

  it('links home', () => {
    renderPage();
    expect(screen.getByRole('link', { name: 'Releases' })).toHaveAttribute('href', '/');
  });
});

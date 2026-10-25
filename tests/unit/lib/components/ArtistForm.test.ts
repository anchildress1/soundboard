import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ArtistForm from '#lib/components/ArtistForm.svelte';
import { ARTIST_C } from '../../../helpers/pipeline';

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const C = {
  name: ARTIST_C.name,
  bandcampUrl: ARTIST_C.bandcampUrl,
  contactLine: ARTIST_C.contactLine,
};
const onsaved = vi.fn();
const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as unknown;
const name = () => screen.getByLabelText('Artist name');
const bandcamp = () => screen.getByLabelText(/^Bandcamp URL/);
const contact = () => screen.getByLabelText(/^Contact line/);
const submit = (label = 'Save') => fireEvent.click(screen.getByRole('button', { name: label }));

beforeEach(() => {
  fetchMock.mockReset();
  onsaved.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('ArtistForm', () => {
  it('starts empty, with plain labels and the documented limits', () => {
    render(ArtistForm, { submitLabel: 'Save', onsaved });
    expect(name()).toHaveValue('');
    expect(name()).toHaveAttribute('maxlength', '100');
    expect(name()).toBeRequired();
    expect(bandcamp()).toHaveAttribute('type', 'url');
    expect(bandcamp()).toHaveAttribute('placeholder', 'https://<name>.bandcamp.com');
    expect(contact()).toHaveAttribute('maxlength', '200');
  });

  it('renders the stored profile, and resubmits untouched fields as stored', async () => {
    fetchMock.mockResolvedValue(json({ artist: C }));
    render(ArtistForm, { initial: C, submitLabel: 'Save changes', onsaved });
    expect(name()).toHaveValue(ARTIST_C.name);
    expect(bandcamp()).toHaveValue(ARTIST_C.bandcampUrl);
    expect(contact()).toHaveValue(ARTIST_C.contactLine);
    await submit('Save changes');
    await waitFor(() => expect(onsaved).toHaveBeenCalledWith(C));
    expect(sentBody()).toEqual(C);
  });

  it('sends empty optional fields as empty strings', async () => {
    fetchMock.mockResolvedValue(
      json({ artist: { name: 'B Band', bandcampUrl: null, contactLine: null } }),
    );
    render(ArtistForm, { submitLabel: 'Save', onsaved });
    await fireEvent.input(name(), { target: { value: 'B Band' } });
    await submit();
    await waitFor(() => expect(onsaved).toHaveBeenCalledOnce());
    expect(sentBody()).toEqual({ name: 'B Band', bandcampUrl: '', contactLine: '' });
  });

  it('shows the saved text after a save', async () => {
    fetchMock.mockResolvedValue(json({ artist: C }));
    render(ArtistForm, { initial: C, submitLabel: 'Save changes', savedText: 'Saved.', onsaved });
    await submit('Save changes');
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('shows each field error under its field and keeps the input', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: 'Fix the highlighted fields.',
          fields: {
            name: 'Add the artist name.',
            bandcampUrl: 'Use your https://<name>.bandcamp.com address.',
            contactLine: "Contact lines can't contain #.",
          },
        },
        422,
      ),
    );
    render(ArtistForm, { submitLabel: 'Save', onsaved });
    await fireEvent.input(bandcamp(), { target: { value: 'http://x' } });
    await fireEvent.input(contact(), { target: { value: 'DM #myband' } });
    await submit();
    expect(await screen.findByText('Add the artist name.')).toBeInTheDocument();
    expect(name()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Use your https://<name>.bandcamp.com address.')).toBeInTheDocument();
    expect(screen.getByText("Contact lines can't contain #.")).toBeInTheDocument();
    expect(screen.getByText('Fix the highlighted fields.')).toBeInTheDocument();
    expect(bandcamp()).toHaveValue('http://x');
    expect(contact()).toHaveValue('DM #myband');
    expect(onsaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('says to try again when the request never answers', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(ArtistForm, { initial: C, submitLabel: 'Save', onsaved });
    await submit();
    expect(await screen.findByText("Couldn't save. Try again.")).toBeInTheDocument();
    expect(name()).toHaveValue(ARTIST_C.name);
    expect(onsaved).not.toHaveBeenCalled();
  });
});

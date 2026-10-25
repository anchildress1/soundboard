import type { ComponentProps } from 'svelte';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprint } from '#lib/fingerprint.js';
import { stop, uploads } from '#lib/upload.js';
import Page from '#src/routes/new/+page.svelte';
import { ARTIST_C } from '../../../helpers/pipeline';
import { installUploadFakes, type FakeLocks } from '../../../helpers/uploads';

type PageData = ComponentProps<typeof Page>['data'];

const FILE_NAME = 'peekaboo.mp4';
const LOCAL_BLOB = 'blob:local-1';
const SESSION = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?upload_id=s1';

const h = vi.hoisted(() => ({ goto: vi.fn(), invalidateAll: vi.fn() }));

vi.mock('$app/navigation', () => ({ goto: h.goto, invalidateAll: h.invalidateAll }));

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ARTIST = { name: ARTIST_C.name, bandcampUrl: ARTIST_C.bandcampUrl };
const setup = (artist: PageData['artist'] = ARTIST) =>
  render(Page, { data: { artist } as PageData });

const start = () => screen.getByRole('button', { name: /Start the release|Starting/ });
const songTitle = () => screen.getByLabelText("What's the song called?");
const picker = (container: HTMLElement) => container.querySelector<HTMLInputElement>('#video')!;
const video = new File(['x'.repeat(10)], FILE_NAME, { type: 'video/mp4' });

async function pickFile(container: HTMLElement, file: File = video, duration = 200) {
  await fireEvent.change(picker(container), { target: { files: [file] } });
  const el = container.querySelector('video')!;
  Object.defineProperty(el, 'duration', { configurable: true, get: () => duration });
  await fireEvent(el, new Event('durationchange'));
}

let locks: FakeLocks;

beforeEach(() => {
  h.goto.mockReset();
  h.invalidateAll.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  locks = installUploadFakes();
  let n = 0;
  URL.createObjectURL = vi.fn(() => {
    n += 1;
    return `blob:local-${n}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  for (const id of Object.keys(get(uploads))) stop(id);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** `/api/jobs` creates the job; the uploader's first confirm then waits forever. */
const created = (id: string) =>
  fetchMock.mockImplementation(async (path) =>
    String(path) === '/api/jobs'
      ? json({ id, sessionUri: SESSION, generation: 1 })
      : new Promise<Response>(() => {}),
  );

describe('new release: artist gate', () => {
  it('asks who the artist is before anything else when there is no profile', () => {
    setup(null);
    expect(screen.getByRole('heading', { name: "Who's the artist?" })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Artist' })).toBeInTheDocument();
    expect(screen.queryByLabelText("What's the song called?")).toBeNull();
  });

  it('saves the profile and reloads the data, which then shows the release form', async () => {
    fetchMock.mockResolvedValue(
      json({ artist: { name: 'B Band', bandcampUrl: null, contactLine: null } }),
    );
    setup(null);
    await fireEvent.input(screen.getByLabelText('Artist name'), { target: { value: 'B Band' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.invalidateAll).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/artist');
  });

  it('goes straight to the release form with a profile', () => {
    setup();
    expect(screen.queryByRole('heading', { name: "Who's the artist?" })).toBeNull();
    expect(songTitle()).toBeInTheDocument();
  });
});

describe('new release: form', () => {
  it('keeps Analyze disabled until a file and a title are given', async () => {
    const { container } = setup();
    expect(start()).toBeDisabled();
    await fireEvent.input(songTitle(), { target: { value: 'PeekaBoo' } });
    expect(start()).toBeDisabled();
    await pickFile(container);
    expect(start()).toBeEnabled();
    await fireEvent.input(songTitle(), { target: { value: '   ' } });
    expect(start()).toBeDisabled();
  });

  it('plays the picked file in the monitor at once', async () => {
    const { container } = setup();
    await pickFile(container);
    expect(container.querySelector('video')).toHaveAttribute('src', LOCAL_BLOB);
    expect(screen.getAllByText(FILE_NAME)).toHaveLength(2);
    expect(screen.getByText('Choose a different file')).toBeInTheDocument();
  });

  it('labels the picker as step 1 of the release, with a way home', () => {
    const { container } = setup();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Pick the finished video');
    expect(screen.getByText('Step 1 of 8 · Upload')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to releases/ })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('link', { name: 'Save & leave' })).toBeNull();
    expect(container.querySelector('.rail .current')).not.toBeNull();
    expect(container.querySelectorAll('.rail .done')).toHaveLength(0);
  });

  it('revokes the previous object URL when another file is picked', async () => {
    const { container } = setup();
    await pickFile(container);
    await pickFile(container, new File(['y'], 'second.mp4', { type: 'video/mp4' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(LOCAL_BLOB);
    expect(container.querySelector('video')).toHaveAttribute('src', 'blob:local-2');
  });

  it('clears the monitor when the picker is emptied', async () => {
    const { container } = setup();
    await pickFile(container);
    await fireEvent.change(picker(container), { target: { files: [] } });
    expect(container.querySelector('video')).toBeNull();
  });

  it('caps videos at 15 minutes', async () => {
    const { container } = setup();
    expect(screen.getByText('Any video file, up to 15 min')).toBeInTheDocument();
    await fireEvent.input(songTitle(), { target: { value: 'PeekaBoo' } });
    await pickFile(container, video, 15 * 60);
    expect(start()).toBeEnabled();
    await pickFile(container, video, 15 * 60 + 1);
    expect(screen.getByText('This video runs over 15 minutes.')).toBeInTheDocument();
    expect(start()).toBeDisabled();
  });

  it('creates the job, starts the upload under its lock, and navigates', async () => {
    created('job1');
    const { container } = setup();
    await fireEvent.input(songTitle(), {
      target: { value: ' PeekaBoo ' },
    });
    await fireEvent.input(screen.getByLabelText(/^Anything it should know/), {
      target: { value: ' first single ' },
    });
    await pickFile(container);
    await fireEvent.click(start());
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/jobs/job1'));
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/jobs');
    const print = await fingerprint(video);
    expect(JSON.parse(String(init!.body))).toEqual({
      songTitle: 'PeekaBoo',
      notes: 'first single',
      filename: FILE_NAME,
      contentType: 'video/mp4',
      size: 10,
      durationSec: 200,
      fingerprint: print,
    });
    expect(locks.holders).toEqual(new Set(['upload:job1']));
    expect(get(uploads).job1).toMatchObject({
      file: video,
      sessionUri: SESSION,
      generation: 1,
      fingerprint: print,
      size: 10,
      state: 'sending',
    });
  });

  it('sends video/mp4 for an untyped file', async () => {
    created('job4');
    const { container } = setup();
    await fireEvent.input(songTitle(), { target: { value: 'PeekaBoo' } });
    await pickFile(container, new File(['x'], 'clip', { type: '' }));
    await fireEvent.click(start());
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/jobs/job4'));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).contentType).toBe('video/mp4');
  });

  it('asks for the file again when it cannot be read, and creates nothing', async () => {
    const { container } = setup();
    await fireEvent.input(songTitle(), { target: { value: 'PeekaBoo' } });
    await pickFile(container);
    vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(
      new DOMException('The file could not be read.', 'NotReadableError'),
    );
    await fireEvent.click(start());
    expect(await screen.findByText("Couldn't read this video. Pick it again.")).toBeInTheDocument();
    expect(start()).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the API error and re-enables the form', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Videos must be under 2 GB.' }, 400));
    const { container } = setup();
    await fireEvent.input(songTitle(), { target: { value: 'PeekaBoo' } });
    await pickFile(container);
    await fireEvent.click(start());
    expect(await screen.findByText('Videos must be under 2 GB.')).toBeInTheDocument();
    expect(start()).toBeEnabled();
    expect(h.goto).not.toHaveBeenCalled();
    expect(get(uploads)).toEqual({});
    expect(locks.holders.size).toBe(0);
  });

  it('falls back to a generic message on a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { container } = setup();
    await fireEvent.input(songTitle(), { target: { value: 'PeekaBoo' } });
    await pickFile(container);
    await fireEvent.click(start());
    expect(await screen.findByText('Could not start the release.')).toBeInTheDocument();
  });

  it('does not submit while incomplete', async () => {
    setup();
    await fireEvent.submit(screen.getByRole('form', { name: 'Start a release' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('new release: cleanup', () => {
  it('revokes an unused object URL on leave', async () => {
    const { container, unmount } = setup();
    await pickFile(container);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(LOCAL_BLOB);
  });
});

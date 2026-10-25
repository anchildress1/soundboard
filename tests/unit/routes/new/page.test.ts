import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takePending } from '$lib/pending';
import Page from '$routes/new/+page.svelte';

const FILE_NAME = 'peekaboo.mp4';
const LOCAL_BLOB = 'blob:local-1';
const SIGNED_PUT = 'https://storage.googleapis.com/put';

const h = vi.hoisted(() => ({ goto: vi.fn() }));

vi.mock('$app/navigation', () => ({ goto: h.goto }));

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const setup = () => render(Page);

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

beforeEach(() => {
  h.goto.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  let n = 0;
  URL.createObjectURL = vi.fn(() => {
    n += 1;
    return `blob:local-${n}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('creates the job, hands the file to the job page, and navigates', async () => {
    fetchMock.mockResolvedValue(json({ id: 'job1', uploadUrl: SIGNED_PUT }));
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
    expect(JSON.parse(String(init!.body))).toEqual({
      songTitle: 'PeekaBoo',
      notes: 'first single',
      filename: FILE_NAME,
      contentType: 'video/mp4',
      size: 10,
      durationSec: 200,
    });
    expect(takePending('job1')).toEqual({
      file: video,
      uploadUrl: SIGNED_PUT,
      objectUrl: LOCAL_BLOB,
      contentType: 'video/mp4',
    });
  });

  it('hands the job page the signed type for an untyped file', async () => {
    fetchMock.mockResolvedValue(json({ id: 'job4', uploadUrl: SIGNED_PUT }));
    const { container } = setup();
    await fireEvent.input(songTitle(), { target: { value: 'PeekaBoo' } });
    await pickFile(container, new File(['x'], 'clip', { type: '' }));
    await fireEvent.click(start());
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/jobs/job4'));
    expect(takePending('job4')?.contentType).toBe('video/mp4');
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

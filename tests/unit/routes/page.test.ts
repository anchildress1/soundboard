import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takePending } from '#lib/pending.js';
import Page from '#src/routes/+page.svelte';

const FILE_NAME = 'peekaboo.mp4';
const LOCAL_BLOB = 'blob:local-1';
const SIGNED_PUT = 'https://storage.googleapis.com/put';

const h = vi.hoisted(() => ({
  goto: vi.fn(),
  page: { url: new URL('https://soundboard.test/') },
}));

vi.mock('$app/navigation', () => ({ goto: h.goto }));
vi.mock('$app/state', () => ({ page: h.page }));

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const USER = { email: 'b@example.com', artistId: null };

type ListedJob = { id: string; songTitle: string; state: string; createdAt: number };

function setup(user: typeof USER | null = USER, jobs: ListedJob[] = []) {
  return render(Page, { props: { data: { user, channel: null, jobs } } as never });
}

const analyze = () => screen.getByRole('button', { name: /Analyze|Starting/ });
const video = new File(['x'.repeat(10)], FILE_NAME, { type: 'video/mp4' });

async function pickFile(container: HTMLElement, file: File = video, duration = 200) {
  await fireEvent.change(screen.getByLabelText(/^Video/), { target: { files: [file] } });
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

describe('home page: job list', () => {
  it('lists the runs under the upload form with a continue link', () => {
    setup(USER, [{ id: 'j1', songTitle: 'PeekaBoo', state: 'REVIEW', createdAt: 1 }]);
    const form = screen.getByRole('form', { name: 'Start a run' });
    const list = screen.getByRole('region', { name: 'Your runs' });
    expect(form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Continue PeekaBoo' })).toHaveAttribute(
      'href',
      '/jobs/j1',
    );
  });

  it('shows no list without runs', () => {
    setup();
    expect(screen.queryByRole('region', { name: 'Your runs' })).toBeNull();
  });
});

describe('home page: signed out', () => {
  it('leaves sign-in to the header: no links, upload form or tape', () => {
    setup(null);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('form', { name: 'Start a run' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'The video' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('home page: form', () => {
  it('keeps Analyze disabled until a file and a title are given', async () => {
    const { container } = setup();
    expect(analyze()).toBeDisabled();
    await fireEvent.input(screen.getByLabelText(/^Song title/), { target: { value: 'PeekaBoo' } });
    expect(analyze()).toBeDisabled();
    await pickFile(container);
    expect(analyze()).toBeEnabled();
    await fireEvent.input(screen.getByLabelText(/^Song title/), { target: { value: '   ' } });
    expect(analyze()).toBeDisabled();
  });

  it('plays the picked file in the monitor at once', async () => {
    const { container } = setup();
    await pickFile(container);
    expect(container.querySelector('video')).toHaveAttribute('src', LOCAL_BLOB);
    expect(screen.getByText(FILE_NAME)).toBeInTheDocument();
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
    await fireEvent.change(screen.getByLabelText(/^Video/), { target: { files: [] } });
    expect(container.querySelector('video')).toBeNull();
  });

  it('caps videos at 15 minutes', async () => {
    const { container } = setup();
    expect(screen.getByText('up to 15 min')).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText(/^Song title/), { target: { value: 'PeekaBoo' } });
    await pickFile(container, video, 15 * 60);
    expect(analyze()).toBeEnabled();
    await pickFile(container, video, 15 * 60 + 1);
    expect(screen.getByText('This video runs over 15 minutes.')).toBeInTheDocument();
    expect(analyze()).toBeDisabled();
  });

  it('creates the job, hands the file to the job page, and navigates', async () => {
    fetchMock.mockResolvedValue(json({ id: 'job1', uploadUrl: SIGNED_PUT }));
    const { container } = setup();
    await fireEvent.input(screen.getByLabelText(/^Song title/), {
      target: { value: ' PeekaBoo ' },
    });
    await fireEvent.input(screen.getByLabelText(/^Notes/), { target: { value: ' first single ' } });
    await pickFile(container);
    await fireEvent.click(analyze());
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
    await fireEvent.input(screen.getByLabelText(/^Song title/), { target: { value: 'PeekaBoo' } });
    await pickFile(container, new File(['x'], 'clip', { type: '' }));
    await fireEvent.click(analyze());
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/jobs/job4'));
    expect(takePending('job4')?.contentType).toBe('video/mp4');
  });

  it('shows the API error and re-enables the form', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Videos must be under 2 GB.' }, 400));
    const { container } = setup();
    await fireEvent.input(screen.getByLabelText(/^Song title/), { target: { value: 'PeekaBoo' } });
    await pickFile(container);
    await fireEvent.click(analyze());
    expect(await screen.findByText('Videos must be under 2 GB.')).toBeInTheDocument();
    expect(analyze()).toBeEnabled();
    expect(h.goto).not.toHaveBeenCalled();
  });

  it('falls back to a generic message on a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { container } = setup();
    await fireEvent.input(screen.getByLabelText(/^Song title/), { target: { value: 'PeekaBoo' } });
    await pickFile(container);
    await fireEvent.click(analyze());
    expect(await screen.findByText('Could not start the run.')).toBeInTheDocument();
  });

  it('does not submit while incomplete', async () => {
    setup();
    await fireEvent.submit(screen.getByRole('form', { name: 'Start a run' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('home page: cleanup', () => {
  it('revokes an unused object URL on leave', async () => {
    const { container, unmount } = setup();
    await pickFile(container);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(LOCAL_BLOB);
  });
});

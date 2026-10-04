import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takePending } from '$lib/pending';
import Page from '$routes/+page.svelte';

const FILE_NAME = 'peekaboo.mp4';
const LOCAL_BLOB = 'blob:local-1';
const SIGNED_PUT = 'https://storage.googleapis.com/put';

const h = vi.hoisted(() => ({ goto: vi.fn() }));

vi.mock('$app/navigation', () => ({ goto: h.goto }));

type Sample = { id: string; songTitle: string; videoId: string; durationSec: number };
type Data = {
  samples: Sample[];
  session: { email: string; allowlisted: boolean; demo: boolean } | null;
};

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(data: Partial<Data> = {}) {
  return render(Page, {
    props: { data: { samples: [], session: null, channel: null, ...data } } as never,
  });
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

  it('caps signed-out videos at 5 minutes', async () => {
    const { container } = setup();
    expect(screen.getByText('up to 5 min')).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText(/^Song title/), { target: { value: 'PeekaBoo' } });
    await pickFile(container, video, 301);
    expect(screen.getByText('This video runs over 5 minutes.')).toBeInTheDocument();
    expect(analyze()).toBeDisabled();
  });

  it('says signed out only when there is no session', () => {
    setup();
    expect(screen.getByText(/^Signed out: your own video ends/)).toBeInTheDocument();
  });

  it('gives the demo account 15 minutes and leaves the demo notice to the layout', () => {
    setup({ session: { email: 'demo@example.com', allowlisted: false, demo: true } });
    expect(screen.getByText('up to 15 min')).toBeInTheDocument();
    expect(screen.queryByText(/Signed out/)).toBeNull();
    expect(screen.queryByText(/sandbox channel/)).toBeNull();
  });

  it('allows Nathan 15 minutes and drops the signed-out note', async () => {
    const { container } = setup({
      session: { email: 'nathan@example.com', allowlisted: true, demo: false },
    });
    expect(screen.getByText('up to 15 min')).toBeInTheDocument();
    expect(screen.queryByText(/Signed out/)).toBeNull();
    await fireEvent.input(screen.getByLabelText(/^Song title/), { target: { value: 'PeekaBoo' } });
    await pickFile(container, video, 12 * 60);
    expect(analyze()).toBeEnabled();
  });

  it('tells a visitor that their own video ends at the payload', () => {
    setup();
    expect(screen.getByText(/ends at the would-be upload payload/)).toBeInTheDocument();
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

  it('defaults an untyped file to video/mp4 and skips the hand-off without an upload URL', async () => {
    fetchMock.mockResolvedValue(json({ id: 'job3', uploadUrl: null }));
    const { container } = setup();
    await fireEvent.input(screen.getByLabelText(/^Song title/), { target: { value: 'PeekaBoo' } });
    await pickFile(container, new File(['x'], 'clip', { type: '' }));
    await fireEvent.click(analyze());
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/jobs/job3'));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).contentType).toBe('video/mp4');
    expect(takePending('job3')).toBeUndefined();
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
    fetchMock.mockResolvedValue(json({ error: 'Today’s 40 public runs are used up.' }, 429));
    const { container } = setup();
    await fireEvent.input(screen.getByLabelText(/^Song title/), { target: { value: 'PeekaBoo' } });
    await pickFile(container);
    await fireEvent.click(analyze());
    expect(await screen.findByText('Today’s 40 public runs are used up.')).toBeInTheDocument();
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

describe('home page: samples', () => {
  const samples: Sample[] = [
    { id: 's1', songTitle: 'Neon', videoId: 'v1', durationSec: 30 },
    { id: 's2', songTitle: 'PeekaBoo', videoId: 'v2', durationSec: 30 },
  ];

  it('hides the samples block when there are none', () => {
    setup();
    expect(screen.queryByText('Samples')).toBeNull();
  });

  it('runs a sample in one tap', async () => {
    fetchMock.mockResolvedValue(json({ id: 'job2', uploadUrl: null }));
    setup({ samples });
    await fireEvent.click(screen.getByRole('button', { name: 'Neon' }));
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/jobs/job2'));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ sampleId: 's1' });
  });

  it('disables the samples while one starts', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    setup({ samples });
    await fireEvent.click(screen.getByRole('button', { name: 'Neon' }));
    expect(screen.getByRole('button', { name: 'PeekaBoo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Starting' })).toBeDisabled();
  });

  it('shows why a sample could not start', async () => {
    fetchMock.mockResolvedValue(json({ error: 'That sample is gone.' }, 404));
    setup({ samples });
    await fireEvent.click(screen.getByRole('button', { name: 'PeekaBoo' }));
    expect(await screen.findByText('That sample is gone.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PeekaBoo' })).toBeEnabled();
  });

  it('falls back to a generic sample message on a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    setup({ samples });
    await fireEvent.click(screen.getByRole('button', { name: 'Neon' }));
    expect(await screen.findByText('Could not start the sample.')).toBeInTheDocument();
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

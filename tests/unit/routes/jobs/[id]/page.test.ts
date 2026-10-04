import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPending } from '$lib/pending';
import type { Chunk, JobView, LiveMetadata, Pick, PublicJob } from '$lib/types';
import Page from '$routes/jobs/[id]/+page.svelte';

const h = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: h.goto }));

const TRACE = { sentryTrace: 'trace-1', baggage: 'bag-1' };

const job = (patch: Partial<PublicJob> = {}): PublicJob => ({
  id: 'j1',
  state: 'REVIEW',
  owner: 'visitor',
  channel: null,
  songTitle: 'PeekaBoo',
  notes: '',
  filename: 'peekaboo.mp4',
  sampleId: null,
  probe: { durationSec: 140, width: 1920, height: 1080, hasAudio: true },
  measurements: null,
  chunkCount: 5,
  chunkIndex: 5,
  failedState: null,
  error: null,
  uploadProgress: null,
  videoId: null,
  payload: null,
  hashtagCandidates: ['#synthwave', '#retrowave'],
  createdAt: 1,
  ...patch,
});

const PICK: Pick = {
  version: 1,
  title: 'PeekaBoo (Official Video)',
  description: 'Night drive.\n\n#synthwave',
  hashtags: ['#synthwave'],
  tags: ['synthwave', 'PeekaBoo'],
  flags: ['Silence 80.0s to 83.0s'],
  brandCheck: 'Keeps the naming pattern.',
  why: { title: 'Matches.', description: 'Plain.', tags: 'Genre first.' },
  bandcamp: { about: 'Bandcamp about.', credits: 'Written by Nathan.' },
  modelMs: 12_000,
};

const chunk = (index: number): Chunk => ({
  index,
  startSec: index * 29.5,
  durationSec: 29.5,
  measurements: {
    integratedLufs: -14,
    truePeakDbtp: -1,
    peakLevelDb: -1,
    clippedSamples: 0,
    silences: [],
  },
  analysis: {
    visual: 'city',
    music: {
      genre: ['synthwave'],
      tempoFeel: 'driving',
      instrumentation: ['synth'],
      vocals: 'male',
      mood: [],
    },
    qualityFlags: [],
  },
  raw: null,
  modelMs: 4000,
});

const view = (patch: Partial<PublicJob> = {}, extra: Partial<JobView> = {}): JobView => ({
  job: job(patch),
  chunks: [],
  pick: null,
  ...extra,
});

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hang = () => new Promise<Response>(() => {});
const paths = () => fetchMock.mock.calls.map(([p]) => String(p));

function setup(
  v: JobView,
  extra: { live?: LiveMetadata | null; playbackUrl?: string | null } = {},
) {
  return render(Page, {
    props: {
      data: {
        view: v,
        playbackUrl: extra.playbackUrl ?? 'https://storage.googleapis.com/bkt/uploads/j1?sig=read',
        live: extra.live ?? null,
        trace: TRACE,
        channel: null,
        session: null,
      },
    } as never,
  });
}

const chip = () => screen.getByRole('status');

const xhr: { status: number; last: FakeXhr | null } = { status: 200, last: null };

class FakeXhr {
  status = 0;
  headers: Record<string, string> = {};
  upload: {
    onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  method = '';
  url = '';
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
    xhr.last = this;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send() {
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.status = xhr.status;
      this.onload?.();
    });
  }
}

beforeEach(() => {
  h.goto.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  xhr.status = 200;
  xhr.last = null;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('job page: status chip', () => {
  it('shows chunk progress and drives the next step with the job trace', async () => {
    fetchMock.mockImplementation(hang);
    setup(view({ state: 'ANALYZE', chunkIndex: 1, chunkCount: 5 }, { chunks: [chunk(0)] }));
    expect(chip()).toHaveTextContent('Chunk 2 / 5');
    expect(screen.getByText('gemma-4-12b-it · 4s')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'PeekaBoo' })).toBeInTheDocument();
    expect(screen.getByText('synthwave')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/jobs/j1/step');
    expect(init!.method).toBe('POST');
    expect(init!.headers).toMatchObject({ 'sentry-trace': 'trace-1', baggage: 'bag-1' });
  });

  it('shows a named wait from the step', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(view({ state: 'ANALYZE', chunkIndex: 0 }, { wait: 'waking model' })),
      )
      .mockImplementation(hang);
    setup(view({ state: 'ANALYZE', chunkIndex: 0 }));
    await waitFor(() => expect(chip()).toHaveTextContent('waking model'));
  });

  it('reads "Needs review" with the recommendation and does not drive', async () => {
    setup(view({ state: 'REVIEW' }, { pick: PICK, chunks: [chunk(0)] }));
    expect(chip()).toHaveTextContent('Needs review');
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(PICK.title);
    expect(screen.getByText('Silence 80.0s to 83.0s')).toBeInTheDocument();
    expect(screen.getByText('Keeps the naming pattern.')).toBeInTheDocument();
    expect(screen.getByText('gemma-4-12b-it · 12s')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Bandcamp' })).toBeInTheDocument();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hides the notes block when there are no flags or brand check', () => {
    setup(view({ state: 'REVIEW' }, { pick: { ...PICK, flags: [], brandCheck: '' } }));
    expect(screen.queryByRole('heading', { name: 'Flags' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Brand check' })).toBeNull();
  });

  it('shows brand check alone when there are no flags', () => {
    setup(view({ state: 'REVIEW' }, { pick: { ...PICK, flags: [] } }));
    expect(screen.queryByRole('heading', { name: 'Flags' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Brand check' })).toBeInTheDocument();
  });

  it('reads "Verified · private" with the video link', () => {
    setup(view({ state: 'VERIFIED', videoId: 'vid1' }, { pick: PICK }));
    expect(chip()).toHaveTextContent('Verified · private');
    const link = screen.getByRole('link', { name: 'youtu.be/vid1' });
    expect(link).toHaveAttribute('href', 'https://youtu.be/vid1');
    expect(screen.getByRole('button', { name: 'Uploaded' })).toBeDisabled();
  });

  it('shows the would-be payload for PAYLOAD', () => {
    const payload = { title: 'PeekaBoo', description: 'd', hashtags: [], tags: ['synthwave'] };
    setup(view({ state: 'PAYLOAD', payload }, { pick: PICK }));
    expect(chip()).toHaveTextContent('Payload ready');
    const block = screen.getByRole('region', { name: 'Would-be upload payload' });
    const body = JSON.parse(block.querySelector('pre')!.textContent!) as Record<string, unknown>;
    expect(body).toEqual({
      snippet: { title: 'PeekaBoo', description: 'd', tags: ['synthwave'], categoryId: '10' },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
    });
    expect((screen.getByLabelText('Title') as HTMLInputElement).readOnly).toBe(true);
  });

  it('renders the live-video diff for a sample', () => {
    const live = { videoId: 'live1', title: 'Neon', description: '', tags: [] };
    setup(view({ state: 'REVIEW' }, { pick: PICK }), { live });
    expect(screen.getByRole('region', { name: 'Current versus proposed' })).toBeInTheDocument();
  });

  it('streams playback from the signed URL', () => {
    const { container } = setup(view({ state: 'REVIEW' }));
    expect(container.querySelector('video')).toHaveAttribute(
      'src',
      'https://storage.googleapis.com/bkt/uploads/j1?sig=read',
    );
    expect(screen.getByText('1080p')).toBeInTheDocument();
  });
});

describe('job page: driving', () => {
  it('moves to review when the steps finish', async () => {
    fetchMock.mockResolvedValueOnce(json(view({ state: 'REVIEW' }, { pick: PICK })));
    setup(view({ state: 'PICK' }));
    expect(chip()).toHaveTextContent('Smart pick');
    await waitFor(() => expect(chip()).toHaveTextContent('Needs review'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops and shows the error when the job is gone', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Job not found' }, 404));
    setup(view({ state: 'ANALYZE', chunkIndex: 0 }));
    expect(await screen.findByText('Job not found')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the job error from a step', async () => {
    fetchMock.mockResolvedValueOnce(
      json(view({ state: 'FAILED', failedState: 'ANALYZE', error: 'ffmpeg exited 1' })),
    );
    setup(view({ state: 'ANALYZE', chunkIndex: 0 }));
    expect(await screen.findByText('ffmpeg exited 1')).toBeInTheDocument();
    expect(chip()).toHaveTextContent('Failed');
  });
});

describe('job page: actions', () => {
  it('approves and shows the resulting payload', async () => {
    const payload = {
      title: PICK.title,
      description: PICK.description,
      hashtags: PICK.hashtags,
      tags: PICK.tags,
    };
    fetchMock.mockResolvedValueOnce(json(view({ state: 'PAYLOAD', payload }, { pick: PICK })));
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.click(screen.getByRole('button', { name: 'Approve & upload' }));
    await waitFor(() => expect(chip()).toHaveTextContent('Payload ready'));
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/jobs/j1/approve');
    expect(init!.headers).toMatchObject({ 'sentry-trace': 'trace-1' });
    expect(JSON.parse(String(init!.body))).toEqual({
      title: PICK.title,
      description: PICK.description,
      tags: PICK.tags,
      pickVersion: PICK.version,
    });
  });

  it('keeps driving after an approval starts the upload', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(view({ state: 'PUBLISHING', uploadProgress: { sent: 0, total: 10 } }, { pick: PICK })),
      )
      .mockImplementation(hang);
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.click(screen.getByRole('button', { name: 'Approve & upload' }));
    await waitFor(() => expect(paths()).toContain('/api/jobs/j1/step'));
    expect(chip()).toHaveTextContent('Uploading to YouTube 0%');
  });

  it('shows field errors from a rejected approval', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: 'Fix the highlighted fields.', fields: { title: 'Rejected title.' } }, 422),
    );
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.click(screen.getByRole('button', { name: 'Approve & upload' }));
    expect(await screen.findByText('Fix the highlighted fields.')).toBeInTheDocument();
    expect(screen.getByText('Rejected title.')).toBeInTheDocument();
  });

  it('re-runs the model and drives the new pick', async () => {
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'PICK' }, { pick: PICK })))
      .mockResolvedValueOnce(
        json(view({ state: 'REVIEW' }, { pick: { ...PICK, version: 2, title: 'Second take' } })),
      );
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.click(screen.getByRole('button', { name: 'Re-run model' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Second take'),
    );
    expect(paths()).toEqual(['/api/jobs/j1/rerun', '/api/jobs/j1/step']);
  });

  it('discards from review and returns to a clean home page', async () => {
    fetchMock.mockResolvedValueOnce(json(view({ state: 'DISCARDED' }, { pick: PICK })));
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/'));
    expect(paths()).toEqual(['/api/jobs/j1/discard']);
  });

  it('stays on the job when a discard is rejected', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'The job moved on.' }, 409));
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.getByText('The job moved on.')).toBeInTheDocument());
    expect(h.goto).not.toHaveBeenCalled();
    expect(chip()).toHaveTextContent('Needs review');
  });

  it('offers retry and discard on a failed job and resumes on retry', async () => {
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'ANALYZE', chunkIndex: 2, chunkCount: 5 })))
      .mockImplementation(hang);
    setup(view({ state: 'FAILED', failedState: 'ANALYZE', chunkIndex: 2, error: 'boom' }));
    expect(chip()).toHaveTextContent('Failed');
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(chip()).toHaveTextContent('Chunk 3 / 5'));
    expect(paths().slice(0, 2)).toEqual(['/api/jobs/j1/retry', '/api/jobs/j1/step']);
  });

  it('discards a failed job', async () => {
    fetchMock.mockResolvedValueOnce(json(view({ state: 'DISCARDED' })));
    setup(view({ state: 'FAILED', failedState: 'PREP' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/'));
  });

  it('shows a network failure on an action', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    setup(view({ state: 'FAILED', failedState: 'PREP' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });
});

describe('job page: upload hand-off', () => {
  const file = new File(['0123456789'], 'peekaboo.mp4', { type: 'video/mp4' });

  it('reports an interrupted upload after a reload', async () => {
    fetchMock.mockResolvedValueOnce(
      json(view({ state: 'AWAITING_UPLOAD', chunkCount: 0, chunkIndex: 0 })),
    );
    setup(view({ state: 'AWAITING_UPLOAD', chunkCount: 0, chunkIndex: 0 }), { playbackUrl: null });
    expect(
      await screen.findByText('The upload was interrupted. Start a new run from the home page.'),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resumes after a reload when the upload already landed', async () => {
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'PREP', chunkCount: 0, chunkIndex: 0 })))
      .mockImplementation(hang);
    setup(view({ state: 'AWAITING_UPLOAD', chunkCount: 0, chunkIndex: 0 }), { playbackUrl: null });
    await waitFor(() => expect(chip()).toHaveTextContent('Measuring audio'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('keeps the view when the reload probe fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    setup(view({ state: 'AWAITING_UPLOAD', chunkCount: 0, chunkIndex: 0 }), { playbackUrl: null });
    expect(await screen.findByText(/upload was interrupted/)).toBeInTheDocument();
  });

  it('PUTs the picked file to GCS, then starts the steps', async () => {
    setPending('j1', {
      file,
      uploadUrl: 'https://storage.googleapis.com/put?sig=1',
      objectUrl: 'blob:local',
      contentType: 'video/mp4',
    });
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'PREP', chunkCount: 0, chunkIndex: 0 })))
      .mockImplementation(hang);
    const { container, unmount } = setup(
      view({ state: 'AWAITING_UPLOAD', chunkCount: 0, chunkIndex: 0 }),
      {
        playbackUrl: null,
      },
    );
    expect(container.querySelector('video')).toHaveAttribute('src', 'blob:local');
    await waitFor(() => expect(chip()).toHaveTextContent('Measuring audio'));
    expect(xhr.last).toMatchObject({
      method: 'PUT',
      url: 'https://storage.googleapis.com/put?sig=1',
      headers: { 'content-type': 'video/mp4', 'x-goog-content-length-range': '1,2147483648' },
    });
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local');
  });

  it('shows a failed GCS upload', async () => {
    xhr.status = 403;
    setPending('j1', {
      file,
      uploadUrl: 'https://storage.googleapis.com/put',
      objectUrl: 'blob:x',
      contentType: 'video/mp4',
    });
    setup(view({ state: 'AWAITING_UPLOAD', chunkCount: 0, chunkIndex: 0 }), { playbackUrl: null });
    expect(await screen.findByText('Upload failed (403)')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

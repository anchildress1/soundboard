import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftKey } from '$lib/draft';
import { setPending } from '$lib/pending';
import { POLL_BACKOFF } from '$lib/retry';
import type { Chunk, JobState, JobView, Pick, PublicJob, Short } from '$lib/types';
import Page from '$routes/jobs/[id]/+page.svelte';

const PLAYBACK_URL = 'https://storage.googleapis.com/bkt/uploads/j1?sig=read';
const WAKING = 'waking model';
const STEP_PATH = '/api/jobs/j1/step';
const FFMPEG_EXITED = 'ffmpeg exited 1';
const APPROVE = 'Approve & upload';
const FIX_FIELDS = 'Fix the highlighted fields.';
const LOCAL_BLOB = 'blob:local';
const MAKE_SHORT = /Make a Short from the hook/;
const SHORT_STEP_PATH = '/api/jobs/s1/step';
const TITLE_SCREEN = 'Does this title work?';
const APPROVE_SCREEN = 'Ready to upload';
const BACK_TO_RELEASE = 'Back to the release';
const OFFERS = 'Up next, if you want';

const h = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: h.goto }));

const TRACE = { sentryTrace: 'trace-1', baggage: 'bag-1' };

const job = (patch: Partial<PublicJob> = {}): PublicJob => ({
  id: 'j1',
  state: 'REVIEW',
  parentId: null,
  destination: null,
  songTitle: 'PeekaBoo',
  notes: '',
  filename: 'peekaboo.mp4',
  probe: { durationSec: 140, width: 1920, height: 1080, hasAudio: true },
  measurements: null,
  chunkCount: 5,
  chunkIndex: 5,
  failedState: null,
  error: null,
  uploadProgress: null,
  videoId: null,
  finalFields: null,
  hashtagCandidates: ['#synthwave', '#retrowave'],
  shortId: null,
  short: null,
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

const FINAL = {
  title: PICK.title,
  description: PICK.description,
  hashtags: PICK.hashtags,
  tags: PICK.tags,
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

const CONNECTED = { channelId: 'UCflr', channelTitle: 'Flies Like Robots' };

function setup(
  v: JobView,
  extra: {
    playbackUrl?: string | null;
    short?: JobView | null;
    expired?: boolean;
    shortExpired?: boolean;
    approveTo?: typeof CONNECTED | null;
  } = {},
) {
  return render(Page, {
    props: {
      data: {
        view: v,
        playbackUrl: extra.playbackUrl === undefined ? PLAYBACK_URL : extra.playbackUrl,
        short: extra.short ?? null,
        shortExpired: extra.shortExpired ?? false,
        expired: extra.expired ?? false,
        approveTo: extra.approveTo === undefined ? CONNECTED : extra.approveTo,
        trace: TRACE,
        channel: null,
        user: null,
      },
    } as never,
  });
}

const chip = () => screen.getByRole('status');
const heading = (name: string | RegExp) => screen.getByRole('heading', { level: 1, name });
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const titleInput = () => screen.getByLabelText(/^Title/) as HTMLInputElement;

/** Walks the review forward to the approval screen, through whichever screens the pick has. */
async function toApprove() {
  for (const name of ['Keep it, next', 'Looks right, next', 'Fine, next', 'Understood, next']) {
    if (screen.queryByRole('heading', { name: APPROVE_SCREEN })) return;
    await fireEvent.click(button(name));
  }
}

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
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('job page: working screens', () => {
  it('keeps the model clock counting while the pick runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      fetchMock.mockImplementation(hang);
      setup(view({ state: 'PICK' }, { pick: PICK, chunks: [chunk(0)] }));
      // A re-run keeps the earlier pick's 12s and counts the new call on top.
      expect(screen.getByText('gemma-4-12b-it · 16s')).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(3000);
      expect(screen.getByText('gemma-4-12b-it · 19s')).toBeInTheDocument();
      expect(heading('Drafting the title, description, and tags')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count while the model is loading', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      fetchMock.mockImplementation(hang);
      setup(view({ state: 'PICK' }, { chunks: [chunk(0)], wait: WAKING }));
      await vi.advanceTimersByTimeAsync(3000);
      expect(screen.getByText('gemma-4-12b-it · 4s')).toBeInTheDocument();
      expect(heading('Waking the model')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows chunk progress, what it heard, and drives the next step with the job trace', async () => {
    fetchMock.mockImplementation(hang);
    setup(view({ state: 'ANALYZE', chunkIndex: 1, chunkCount: 5 }, { chunks: [chunk(0)] }));
    expect(chip()).toHaveTextContent('Chunk 2 / 5');
    expect(heading('Listening to the video')).toBeInTheDocument();
    expect(screen.getByText(/^Window 2 of 5\./)).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 8 · Listening')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to releases from PeekaBoo' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(screen.getByText('synthwave')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: OFFERS })).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe(STEP_PATH);
    expect(init!.method).toBe('POST');
    expect(init!.headers).toMatchObject({ 'sentry-trace': 'trace-1', baggage: 'bag-1' });
  });

  it('shows a named wait from the step', async () => {
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'ANALYZE', chunkIndex: 0 }, { wait: WAKING })))
      .mockImplementation(hang);
    setup(view({ state: 'ANALYZE', chunkIndex: 0 }));
    await waitFor(() => expect(chip()).toHaveTextContent(WAKING));
    expect(heading('Waking the model')).toBeInTheDocument();
  });

  it('streams playback from the signed URL', () => {
    fetchMock.mockImplementation(hang);
    const { container } = setup(view({ state: 'ANALYZE', chunkIndex: 1 }));
    expect(container.querySelector('video')).toHaveAttribute('src', PLAYBACK_URL);
    expect(screen.getByText('1080p')).toBeInTheDocument();
  });

  it('keeps the saved details and asks for a new upload once the media expired', () => {
    setup(view({ state: 'REVIEW' }, { pick: PICK }), { expired: true, playbackUrl: null });
    expect(screen.getByRole('note')).toHaveTextContent(/gone from storage after 7 days/);
    expect(screen.getByRole('note')).toHaveTextContent(/upload it again/);
    expect(titleInput()).toHaveValue(PICK.title);
  });

  it('says nothing about storage while the media is there', () => {
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('job page: review', () => {
  it('opens on the title screen and does not drive', async () => {
    setup(view({ state: 'REVIEW' }, { pick: PICK, chunks: [chunk(0)] }));
    expect(heading(TITLE_SCREEN)).toBeInTheDocument();
    expect(titleInput().value).toBe(PICK.title);
    expect(screen.getByText('Step 3 of 8 · Title')).toBeInTheDocument();
    // Review is the user's screen: no working status, no brand check, no offers yet.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(PICK.brandCheck)).toBeNull();
    expect(screen.queryByRole('heading', { name: OFFERS })).toBeNull();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('moves the release bar with each review screen', async () => {
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.click(button('Keep it, next'));
    expect(screen.getByText('Step 4 of 8 · Description')).toBeInTheDocument();
    await fireEvent.click(button('Looks right, next'));
    expect(screen.getByText('Step 5 of 8 · Tags')).toBeInTheDocument();
    await fireEvent.click(button('Fine, next'));
    expect(screen.getByText('Step 6 of 8 · Check')).toBeInTheDocument();
    expect(screen.getByText('Silence 80.0s to 83.0s')).toBeInTheDocument();
    await fireEvent.click(button('Understood, next'));
    expect(screen.getByText('Step 7 of 8 · Approve')).toBeInTheDocument();
    await fireEvent.click(button('Back'));
    expect(screen.getByText('Step 6 of 8 · Check')).toBeInTheDocument();
  });

  it('skips the check screen when ffmpeg flagged nothing', async () => {
    setup(view({ state: 'REVIEW' }, { pick: { ...PICK, flags: [] } }));
    await fireEvent.click(button('Keep it, next'));
    await fireEvent.click(button('Looks right, next'));
    await fireEvent.click(button('Fine, next'));
    expect(heading(APPROVE_SCREEN)).toBeInTheDocument();
    await fireEvent.click(button('Back'));
    expect(heading('Check the tags')).toBeInTheDocument();
  });

  it('keeps edits and the screen in this browser across a reload', async () => {
    const first = setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.input(titleInput(), { target: { value: 'Draft edit' } });
    await fireEvent.click(button('Keep it, next'));
    first.unmount();
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    expect(heading('Read the description')).toBeInTheDocument();
    await fireEvent.click(button('Back'));
    expect(titleInput().value).toBe('Draft edit');
  });

  it("starts from the model's new draft on a new pick version", () => {
    localStorage.setItem(
      draftKey('j1', 1),
      JSON.stringify({ title: 'Old edit', description: 'd', tags: 't', step: 'tags' }),
    );
    setup(view({ state: 'REVIEW' }, { pick: { ...PICK, version: 2, title: 'Second take' } }));
    expect(heading(TITLE_SCREEN)).toBeInTheDocument();
    expect(titleInput().value).toBe('Second take');
  });

  it('approves with the edited fields, clears the draft, and shows the upload starting', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(
          view({ state: 'PUBLISHING', finalFields: { ...FINAL, title: 'Edited' } }, { pick: PICK }),
        ),
      )
      .mockImplementation(hang);
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.input(titleInput(), { target: { value: 'Edited' } });
    expect(localStorage.getItem(draftKey('j1', 1))).toContain('Edited');
    await toApprove();
    expect(screen.getByText('Flies Like Robots')).toBeInTheDocument();
    expect(screen.getByText('UCflr')).toBeInTheDocument();
    await fireEvent.click(button(APPROVE));
    await waitFor(() => expect(heading('Uploading to YouTube')).toBeInTheDocument());
    expect(chip()).toHaveTextContent('Uploading to YouTube 0%');
    expect(screen.getByText('Edited', { selector: 'strong' })).toBeInTheDocument();
    expect(localStorage.getItem(draftKey('j1', 1))).toBeNull();
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/jobs/j1/approve');
    expect(init!.headers).toMatchObject({ 'sentry-trace': 'trace-1' });
    expect(JSON.parse(String(init!.body))).toEqual({
      title: 'Edited',
      description: PICK.description,
      tags: PICK.tags,
      pickVersion: PICK.version,
      channelId: CONNECTED.channelId,
    });
    await waitFor(() => expect(paths()).toContain(STEP_PATH));
  });

  it('sends YouTube reconnection instead of approving while no channel is connected', async () => {
    setup(view({ state: 'REVIEW' }, { pick: PICK }), { approveTo: null });
    await toApprove();
    expect(screen.getByText('Reconnect YouTube to upload.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reconnect YouTube' })).toHaveAttribute(
      'href',
      '/connections',
    );
    expect(screen.queryByRole('button', { name: APPROVE })).toBeNull();
  });

  it('disables the next step while a field is invalid', async () => {
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.input(titleInput(), { target: { value: '   ' } });
    expect(screen.getByText('Title is required.')).toBeInTheDocument();
    expect(button('Keep it, next')).toBeDisabled();
  });

  it('lands on the refused field when the server rejects the approval', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: FIX_FIELDS, fields: { title: 'Rejected title.' } }, 422),
    );
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await toApprove();
    await fireEvent.click(button(APPROVE));
    expect(await screen.findByText(FIX_FIELDS)).toBeInTheDocument();
    expect(heading(TITLE_SCREEN)).toBeInTheDocument();
    expect(screen.getByText('Rejected title.')).toBeInTheDocument();
    expect(h.goto).not.toHaveBeenCalled();
  });

  it('re-runs the model and drives the new pick', async () => {
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'PICK' }, { pick: PICK })))
      .mockResolvedValueOnce(
        json(view({ state: 'REVIEW' }, { pick: { ...PICK, version: 2, title: 'Second take' } })),
      );
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.click(button('Re-run model'));
    await waitFor(() => expect(titleInput().value).toBe('Second take'));
    expect(paths()).toEqual(['/api/jobs/j1/rerun', STEP_PATH]);
  });

  it('opens the new pick on its title when re-run from a later screen', async () => {
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'PICK' }, { pick: PICK })))
      .mockResolvedValueOnce(
        json(view({ state: 'REVIEW' }, { pick: { ...PICK, version: 2, title: 'Second take' } })),
      );
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.click(button('Keep it, next'));
    await fireEvent.click(button('Re-run model'));
    await waitFor(() => expect(titleInput().value).toBe('Second take'));
    expect(heading(TITLE_SCREEN)).toBeInTheDocument();
  });

  it('discards the release and returns home', async () => {
    fetchMock.mockResolvedValueOnce(json(view({ state: 'DISCARDED' }, { pick: PICK })));
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await toApprove();
    await fireEvent.click(button('Discard release'));
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/'));
    expect(paths()).toEqual(['/api/jobs/j1/discard']);
  });

  it('stays on the release when a discard is rejected', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'The job moved on.' }, 409));
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await toApprove();
    await fireEvent.click(button('Discard release'));
    expect(await screen.findByText('The job moved on.')).toBeInTheDocument();
    expect(h.goto).not.toHaveBeenCalled();
    expect(heading(APPROVE_SCREEN)).toBeInTheDocument();
  });
});

describe('job page: end states', () => {
  it('reads "Verified · private" with the video link and a way home', () => {
    setup(view({ state: 'VERIFIED', videoId: 'vid1' }, { pick: PICK }));
    expect(heading("It's on your channel")).toBeInTheDocument();
    expect(screen.getByText('Verified · private')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'youtu.be/vid1' })).toHaveAttribute(
      'href',
      'https://youtu.be/vid1',
    );
    expect(screen.getByRole('link', { name: "I'm done for now" })).toHaveAttribute('href', '/');
  });

  it('shows no video link on a verified release without a video ID', () => {
    setup(view({ state: 'VERIFIED' }, { pick: PICK }));
    expect(screen.queryByRole('link', { name: /youtu\.be/ })).toBeNull();
  });

  it('says a discarded release is over', () => {
    setup(view({ state: 'DISCARDED' }, { pick: PICK }));
    expect(heading('This release was discarded')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });

  it("shows a failed job's error on load, not only after a step", () => {
    setup(view({ state: 'FAILED', failedState: 'ANALYZE', error: FFMPEG_EXITED }));
    expect(heading('This step failed')).toBeInTheDocument();
    expect(screen.getByText(FFMPEG_EXITED)).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 8 · Listening')).toBeInTheDocument();
  });

  it('offers retry and discard on a failed job and resumes on retry', async () => {
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'ANALYZE', chunkIndex: 2, chunkCount: 5 })))
      .mockImplementation(hang);
    setup(view({ state: 'FAILED', failedState: 'ANALYZE', chunkIndex: 2, error: 'boom' }));
    expect(button('Discard')).toBeEnabled();
    await fireEvent.click(button('Retry'));
    await waitFor(() => expect(chip()).toHaveTextContent('Chunk 3 / 5'));
    expect(paths().slice(0, 2)).toEqual(['/api/jobs/j1/retry', STEP_PATH]);
  });

  it('discards a failed job', async () => {
    fetchMock.mockResolvedValueOnce(json(view({ state: 'DISCARDED' })));
    setup(view({ state: 'FAILED', failedState: 'PREP' }));
    await fireEvent.click(button('Discard'));
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/'));
  });

  it('shows a network failure on an action', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    setup(view({ state: 'FAILED', failedState: 'PREP' }));
    await fireEvent.click(button('Retry'));
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
    expect(button('Retry')).toBeEnabled();
  });
});

describe('job page: driving', () => {
  it('moves to review when the steps finish', async () => {
    fetchMock.mockResolvedValueOnce(json(view({ state: 'REVIEW' }, { pick: PICK })));
    setup(view({ state: 'PICK' }));
    expect(chip()).toHaveTextContent('Smart pick');
    await waitFor(() => expect(heading(TITLE_SCREEN)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops and shows the error when the job is gone', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Job not found' }, 404));
    setup(view({ state: 'ANALYZE', chunkIndex: 0 }));
    expect(await screen.findByText('Job not found')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('goes home to sign in when a step finds the session gone', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Sign in first.' }, 401));
    setup(view({ state: 'ANALYZE', chunkIndex: 0 }));
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/', { invalidateAll: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the job error from a step', async () => {
    fetchMock.mockResolvedValueOnce(
      json(view({ state: 'FAILED', failedState: 'ANALYZE', error: FFMPEG_EXITED })),
    );
    setup(view({ state: 'ANALYZE', chunkIndex: 0 }));
    expect(await screen.findByText(FFMPEG_EXITED)).toBeInTheDocument();
    expect(heading('This step failed')).toBeInTheDocument();
  });
});

describe('job page: paused publish', () => {
  const publishing = (wait?: JobView['wait'], patch: Partial<PublicJob> = {}) =>
    view(
      { state: 'PUBLISHING', destination: CONNECTED, finalFields: FINAL, ...patch },
      { pick: PICK, ...(wait ? { wait } : {}) },
    );
  /** Steps answer `stepView`; every other call answers by path. */
  const serve = (stepView: JobView, other: Record<string, Response> = {}) =>
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      return path === STEP_PATH ? json(stepView) : (other[path] ?? hang());
    });
  const paused = () => screen.findByRole('region', { name: 'Upload outcome unknown' });

  it('links the pinned channel in YouTube Studio and offers a pasted link and Discard', async () => {
    serve(publishing('upload outcome unknown'));
    setup(publishing());
    const panel = await paused();
    expect(
      within(panel).getByRole('link', { name: 'Open YouTube Studio uploads' }),
    ).toHaveAttribute('href', 'https://studio.youtube.com/channel/UCflr/videos/upload');
    expect(within(panel).getByLabelText('Video link')).toBeEnabled();
    expect(within(panel).getByRole('button', { name: 'Confirm video' })).toBeDisabled();
    expect(button('Discard')).toBeEnabled();
    expect(chip()).toHaveTextContent('upload outcome unknown');
    expect(heading('Upload paused')).toBeInTheDocument();
  });

  it('posts the pasted link to confirm-upload and drops the panel once confirmed', async () => {
    const url = 'https://youtu.be/dQw4w9WgXcQ';
    serve(publishing('upload outcome unknown'), {
      '/api/jobs/j1/confirm-upload': json(
        view(
          {
            state: 'CLAIMED_COMPLETE',
            destination: CONNECTED,
            finalFields: FINAL,
            videoId: 'dQw4w9WgXcQ',
          },
          { pick: PICK },
        ),
      ),
    });
    setup(publishing());
    const panel = await paused();
    await fireEvent.input(within(panel).getByLabelText('Video link'), { target: { value: url } });
    await fireEvent.click(within(panel).getByRole('button', { name: 'Confirm video' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Upload outcome unknown' })).toBeNull(),
    );
    const call = fetchMock.mock.calls.find(([p]) => String(p) === '/api/jobs/j1/confirm-upload')!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ url });
  });

  it('shows why a pasted link was refused and keeps the panel', async () => {
    serve(publishing('upload outcome unknown'), {
      '/api/jobs/j1/confirm-upload': json({ error: "That video isn't on Flies Like Robots." }, 422),
    });
    setup(publishing());
    const panel = await paused();
    await fireEvent.input(within(panel).getByLabelText('Video link'), {
      target: { value: 'https://youtu.be/dQw4w9WgXcQ' },
    });
    await fireEvent.click(within(panel).getByRole('button', { name: 'Confirm video' }));
    expect(await screen.findByText("That video isn't on Flies Like Robots.")).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Upload outcome unknown' })).toBeInTheDocument();
  });

  it('points a job that lost YouTube access to Connections and lets it be discarded', async () => {
    serve(publishing('reconnect YouTube'), {
      '/api/jobs/j1/discard': json(view({ state: 'DISCARDED' }, { pick: PICK })),
    });
    setup(publishing());
    const panel = await screen.findByRole('region', { name: 'Upload paused' });
    expect(within(panel).getByRole('link', { name: 'Reconnect on Connections' })).toHaveAttribute(
      'href',
      '/connections',
    );
    await fireEvent.click(button('Discard'));
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/'));
  });

  it('lets a verifying job that lost access be discarded too', async () => {
    serve(publishing('reconnect YouTube', { state: 'CLAIMED_COMPLETE', videoId: 'vid1' }));
    setup(publishing(undefined, { state: 'CLAIMED_COMPLETE', videoId: 'vid1' }));
    await screen.findByRole('region', { name: 'Upload paused' });
    expect(button('Discard')).toBeEnabled();
  });

  it('shows no paused panel and no Discard while the upload runs', async () => {
    serve(publishing());
    setup(publishing());
    await waitFor(() => expect(paths()).toContain(STEP_PATH));
    expect(screen.queryByRole('region', { name: /Upload (paused|outcome unknown)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(screen.getByText(PICK.title, { selector: 'strong' })).toBeInTheDocument();
  });

  it('lets a job waiting on the daily limit be discarded, with no paused panel', async () => {
    serve(publishing('Daily upload limit reached. Try tomorrow.'));
    setup(publishing());
    await waitFor(() => expect(button('Discard')).toBeEnabled());
    expect(heading('Daily upload limit reached')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Upload (paused|outcome unknown)/ })).toBeNull();
  });
});

describe('job page: upload hand-off', () => {
  const file = new File(['0123456789'], 'peekaboo.mp4', { type: 'video/mp4' });
  const awaitingView = () => view({ state: 'AWAITING_UPLOAD', chunkCount: 0, chunkIndex: 0 });

  it('reports an interrupted upload after a reload', async () => {
    fetchMock.mockResolvedValueOnce(json(awaitingView()));
    setup(awaitingView(), { playbackUrl: null });
    expect(heading('Uploading your video')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 8 · Upload')).toBeInTheDocument();
    expect(
      await screen.findByText('The upload was interrupted. Start a new run from the home page.'),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resumes after a reload when the upload already landed', async () => {
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'PREP', chunkCount: 0, chunkIndex: 0 })))
      .mockImplementation(hang);
    setup(awaitingView(), { playbackUrl: null });
    await waitFor(() => expect(chip()).toHaveTextContent('Measuring audio'));
    expect(heading('Measuring the audio')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('keeps the view when the reload probe fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    setup(awaitingView(), { playbackUrl: null });
    expect(await screen.findByText(/upload was interrupted/)).toBeInTheDocument();
  });

  it('PUTs the picked file to GCS, then starts the steps', async () => {
    setPending('j1', {
      file,
      uploadUrl: 'https://storage.googleapis.com/put?sig=1',
      objectUrl: LOCAL_BLOB,
      contentType: 'video/mp4',
    });
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'PREP', chunkCount: 0, chunkIndex: 0 })))
      .mockImplementation(hang);
    const { container, unmount } = setup(awaitingView(), { playbackUrl: null });
    expect(container.querySelector('video')).toHaveAttribute('src', LOCAL_BLOB);
    await waitFor(() => expect(chip()).toHaveTextContent('Measuring audio'));
    expect(xhr.last).toMatchObject({
      method: 'PUT',
      url: 'https://storage.googleapis.com/put?sig=1',
      headers: { 'content-type': 'video/mp4', 'x-goog-content-length-range': '1,2147483648' },
    });
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(LOCAL_BLOB);
  });

  const pend = () =>
    setPending('j1', {
      file,
      uploadUrl: 'https://storage.googleapis.com/put?sig=1',
      objectUrl: LOCAL_BLOB,
      contentType: 'video/mp4',
    });
  const awaiting = () => json(awaitingView());

  it('looks again with backoff until the upload lands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      pend();
      fetchMock
        .mockResolvedValueOnce(awaiting())
        .mockResolvedValueOnce(json(view({ state: 'PREP', chunkCount: 0, chunkIndex: 0 })))
        .mockImplementation(hang);
      setup(awaitingView(), { playbackUrl: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(POLL_BACKOFF.minTimeout);
      expect(chip()).toHaveTextContent('Measuring audio');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands off to the steps after five looks find no upload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      pend();
      fetchMock.mockImplementation(async () => awaiting());
      setup(awaitingView(), { playbackUrl: null });
      await vi.runAllTimersAsync();
      const steps = fetchMock.mock.calls.filter(([url]) => String(url).endsWith(STEP_PATH));
      expect(steps).toHaveLength(5);
      expect(screen.queryByText(/failed/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops looking for the upload once the page is left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      pend();
      fetchMock.mockImplementation(async () => awaiting());
      const { unmount } = setup(awaitingView(), { playbackUrl: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      unmount();
      await vi.runAllTimersAsync();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a step error while looking for the upload', async () => {
    pend();
    fetchMock.mockResolvedValueOnce(json({ error: 'Internal' }, 500));
    setup(awaitingView(), { playbackUrl: null });
    expect(await screen.findByText('Internal')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a failed GCS upload', async () => {
    xhr.status = 403;
    setPending('j1', {
      file,
      uploadUrl: 'https://storage.googleapis.com/put',
      objectUrl: 'blob:x',
      contentType: 'video/mp4',
    });
    setup(awaitingView(), { playbackUrl: null });
    expect(await screen.findByText('Upload failed (403)')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const SPEC: Short = {
  sourceDurationSec: 140,
  reframe: 'blur',
  hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'The chorus lands.' },
  skipped: [],
  renders: 1,
  modelMs: 6_000,
};

const shortView = (
  state: JobState,
  spec: Partial<Short> = {},
  extra: Partial<JobView> = {},
  patch: Partial<PublicJob> = {},
): JobView => ({
  job: job({
    id: 's1',
    state,
    parentId: 'j1',
    filename: 'peekaboo (Short).mp4',
    probe: { durationSec: 30, width: 720, height: 1280, hasAudio: true },
    short: { ...SPEC, ...spec },
    ...patch,
  }),
  chunks: [],
  pick: PICK,
  ...extra,
});

/** A verified video: nothing drives it, so every request in a test is the Short's. */
const verified = (patch: Partial<PublicJob> = {}, pick: Pick = PICK) =>
  view({ state: 'VERIFIED', videoId: 'vid1', finalFields: FINAL, ...patch }, { pick });
const URL_A = 'https://storage.googleapis.com/bkt/uploads/s1-1?sig=a';
const URL_B = 'https://storage.googleapis.com/bkt/uploads/s1-2?sig=b';
const shortOffer = () => button(/Finish the Short|Your Short/);
const makeShortOffer = () => button(MAKE_SHORT);

describe('job page: offers', () => {
  it.each(['PUBLISHING', 'CLAIMED_COMPLETE', 'VERIFIED'] as JobState[])(
    'offers a Short and Bandcamp once the release is approved (%s)',
    (state) => {
      fetchMock.mockImplementation(hang);
      setup(view({ state, finalFields: FINAL, destination: CONNECTED }, { pick: PICK }));
      expect(screen.getByRole('heading', { name: OFFERS })).toBeInTheDocument();
      expect(makeShortOffer()).toBeEnabled();
      expect(makeShortOffer()).toHaveTextContent('A vertical cut of the strongest moment');
      expect(button(/Put it on Bandcamp/)).toHaveTextContent(
        'Copy the drafted fields into Bandcamp.',
      );
    },
  );

  it('offers nothing on a release that failed in its upload', () => {
    setup(view({ state: 'FAILED', failedState: 'PUBLISHING', finalFields: FINAL }, { pick: PICK }));
    expect(screen.queryByRole('heading', { name: OFFERS })).toBeNull();
  });

  it('disables the Short offer and says why for a video under 15 seconds', () => {
    const probe = { durationSec: 14.9, width: 1920, height: 1080, hasAudio: true };
    setup(verified({ probe }));
    expect(makeShortOffer()).toBeDisabled();
    expect(makeShortOffer()).toHaveTextContent('A Short needs a video of at least 15 seconds.');
  });

  it('offers a Short for a video of exactly 15 seconds', () => {
    const probe = { durationSec: 15, width: 1920, height: 1080, hasAudio: true };
    setup(verified({ probe }));
    expect(makeShortOffer()).toBeEnabled();
  });

  it('opens Bandcamp in its own room and comes back to the offers', async () => {
    setup(verified());
    await fireEvent.click(button(/Put it on Bandcamp/));
    expect(heading('Copy these into Bandcamp')).toBeInTheDocument();
    expect(screen.getByText('Bandcamp', { selector: '.label' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: OFFERS })).toBeNull();
    await fireEvent.click(button(BACK_TO_RELEASE));
    expect(heading("It's on your channel")).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: OFFERS })).toBeInTheDocument();
  });

  it('marks Bandcamp done once every field was copied', async () => {
    const tags = FINAL.tags.join(', ');
    localStorage.setItem(
      'bandcamp:j1:1',
      JSON.stringify({
        'Track name': 'PeekaBoo',
        About: PICK.bandcamp.about,
        Credits: PICK.bandcamp.credits,
        Tags: tags,
      }),
    );
    setup(verified());
    await fireEvent.click(button(/Put it on Bandcamp/));
    await fireEvent.click(button(BACK_TO_RELEASE));
    expect(button(/Put it on Bandcamp/)).toHaveTextContent('Every field copied.');
  });

  it('makes a Short, opens its room, and drives its steps in the job trace', async () => {
    fetchMock
      .mockResolvedValueOnce(json(shortView('HOOK', { hook: null, renders: 0, modelMs: 0 })))
      .mockResolvedValueOnce(json(shortView('RENDER')))
      .mockResolvedValueOnce(json(shortView('REVIEW', {}, { playbackUrl: URL_A })));
    const { container } = setup(verified());
    await fireEvent.click(makeShortOffer());
    expect(await screen.findByRole('heading', { name: 'Is this the hook?' })).toBeInTheDocument();
    expect(screen.getByText('Short', { selector: '.label' })).toBeInTheDocument();
    await waitFor(() => expect(chip()).toHaveTextContent('Needs review'));
    expect(paths()).toEqual(['/api/jobs/j1/short', SHORT_STEP_PATH, SHORT_STEP_PATH]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init!.headers).toMatchObject({ 'sentry-trace': 'trace-1', baggage: 'bag-1' });
    }
    expect(container.querySelector('video')).toHaveAttribute('src', URL_A);
  });

  it('keeps the Short offer disabled while the Short is starting', async () => {
    fetchMock.mockImplementation(hang);
    setup(verified());
    await fireEvent.click(makeShortOffer());
    await waitFor(() => expect(makeShortOffer()).toBeDisabled());
    expect(screen.queryByRole('heading', { name: 'Is this the hook?' })).toBeNull();
  });

  it('shows why a Short could not start and stays on the release', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: "This video's length is unknown.", fields: null }, 409),
    );
    setup(verified());
    await fireEvent.click(makeShortOffer());
    expect(await screen.findByText("This video's length is unknown.")).toBeInTheDocument();
    expect(makeShortOffer()).toBeEnabled();
    expect(heading("It's on your channel")).toBeInTheDocument();
  });

  it('offers to finish a Short in progress', async () => {
    setup(verified({ shortId: 's1' }), { short: shortView('REVIEW', {}, { playbackUrl: URL_A }) });
    expect(shortOffer()).toHaveTextContent('Finish the Short');
    expect(shortOffer()).toHaveTextContent('Its own review and upload.');
    await fireEvent.click(shortOffer());
    expect(heading('Is this the hook?')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'YouTube Short' })).toBeInTheDocument();
  });

  it('shows a verified Short with its link', async () => {
    setup(verified({ shortId: 's1' }), {
      short: shortView('VERIFIED', {}, { playbackUrl: URL_A }, { videoId: 'short1' }),
    });
    expect(shortOffer()).toHaveTextContent('Your Short');
    expect(shortOffer()).toHaveTextContent('Uploaded and verified.');
    await fireEvent.click(shortOffer());
    expect(screen.getByRole('link', { name: 'youtu.be/short1' })).toHaveAttribute(
      'href',
      'https://youtu.be/short1',
    );
  });

  it('keeps every id on the page unique in the Short room', async () => {
    const { container } = setup(verified({ shortId: 's1' }), {
      short: shortView('REVIEW', {}, { playbackUrl: URL_A }),
    });
    await fireEvent.click(shortOffer());
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const el of container.querySelectorAll('label[for]')) {
      expect(container.querySelector(`#${el.getAttribute('for')}`)).not.toBeNull();
    }
  });
});

describe('job page: Short room', () => {
  const publishingShort = (wait?: JobView['wait']) =>
    shortView('PUBLISHING', {}, { wait }, { destination: CONNECTED });

  async function openShort(short: JobView, extra: { shortExpired?: boolean } = {}) {
    const rendered = setup(verified({ shortId: 's1' }), { short, ...extra });
    await fireEvent.click(shortOffer());
    return rendered;
  }

  it('resumes driving a running Short on reload without driving the finished video', async () => {
    fetchMock.mockImplementation(hang);
    setup(verified({ shortId: 's1' }), { short: shortView('RENDER') });
    await waitFor(() => expect(paths()).toEqual([SHORT_STEP_PATH]));
  });

  it('keeps the player on its URL until a new render lands', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(
          shortView(
            'PUBLISHING',
            {},
            { playbackUrl: URL_B },
            { uploadProgress: { sent: 1, total: 2 } },
          ),
        ),
      )
      .mockImplementation(hang);
    const { container } = await openShort(shortView('PUBLISHING', {}, { playbackUrl: URL_A }));
    await waitFor(() => expect(chip()).toHaveTextContent('Uploading to YouTube 50%'));
    expect(container.querySelector('video')).toHaveAttribute('src', URL_A);
  });

  it('confirms an uncertain Short upload using only the Short job', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/api/jobs/s1/confirm-upload') {
        return json(shortView('VERIFIED', {}, {}, { videoId: 'short-video' }));
      }
      return hang();
    });
    await openShort(publishingShort('upload outcome unknown'));
    const panel = screen.getByRole('region', { name: 'Upload outcome unknown' });
    expect(
      within(panel).getByRole('link', { name: 'Open YouTube Studio uploads' }),
    ).toHaveAttribute('href', 'https://studio.youtube.com/channel/UCflr/videos/upload');
    expect(within(panel).getByRole('button', { name: 'Confirm video' })).toBeDisabled();
    const url = 'https://youtu.be/short-video';
    await fireEvent.input(within(panel).getByLabelText('Video link'), { target: { value: url } });
    await fireEvent.click(within(panel).getByRole('button', { name: 'Confirm video' }));
    expect(await screen.findByText(/Short uploaded to YouTube · private/)).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([p]) => String(p) === '/api/jobs/s1/confirm-upload')!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ url });
    expect(paths()).not.toContain('/api/jobs/j1/confirm-upload');
    expect(screen.queryByRole('region', { name: 'Upload outcome unknown' })).toBeNull();
    await fireEvent.click(button(BACK_TO_RELEASE));
    expect(shortOffer()).toHaveTextContent('Your Short');
  });

  it('keeps a rejected Short link editable and shows the error in the Short room', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/confirm-upload') ? json({ error: 'Wrong channel.' }, 422) : hang(),
    );
    await openShort(publishingShort('upload outcome unknown'));
    const panel = screen.getByRole('region', { name: 'Upload outcome unknown' });
    await fireEvent.input(within(panel).getByLabelText('Video link'), {
      target: { value: 'https://youtu.be/other-video' },
    });
    await fireEvent.click(within(panel).getByRole('button', { name: 'Confirm video' }));
    expect(await screen.findByText('Wrong channel.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Confirm video' })).toBeEnabled();
  });

  it.each([
    'upload outcome unknown',
    'reconnect YouTube',
    'Daily upload limit reached. Try tomorrow.',
  ] as const)('discards only the paused Short on %s', async (wait) => {
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/discard') ? json(shortView('DISCARDED')) : hang(),
    );
    await openShort(publishingShort(wait));
    const discard = button('Discard');
    expect(discard).toBeEnabled();
    await fireEvent.click(discard);
    // The Short is gone, so its room closes and the release offers a new one.
    expect(await screen.findByRole('button', { name: MAKE_SHORT })).toBeEnabled();
    expect(screen.queryByRole('button', { name: BACK_TO_RELEASE })).toBeNull();
    expect(paths()).toContain('/api/jobs/s1/discard');
    expect(paths()).not.toContain('/api/jobs/j1/discard');
    expect(h.goto).not.toHaveBeenCalled();
  });

  it('keeps Discard disabled while the Short upload is active', async () => {
    fetchMock.mockImplementation(hang);
    await openShort(publishingShort());
    expect(button('Discard')).toBeDisabled();
    expect(screen.queryByRole('region', { name: 'Upload outcome unknown' })).toBeNull();
  });

  it('ignores a delayed Short poll after discarding it', async () => {
    const delayed = Promise.withResolvers<Response>();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === SHORT_STEP_PATH) return delayed.promise;
      if (String(input) === '/api/jobs/s1/discard') return json(shortView('DISCARDED'));
      return hang();
    });
    await openShort(publishingShort('upload outcome unknown'));
    await waitFor(() => expect(paths()).toContain(SHORT_STEP_PATH));
    await fireEvent.click(button('Discard'));
    await fireEvent.click(await screen.findByRole('button', { name: MAKE_SHORT }));
    await waitFor(() => expect(paths()).toContain('/api/jobs/j1/short'));
    delayed.resolve(json(publishingShort('upload outcome unknown')));
    await delayed.promise;
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: /Finish the Short/ })).toBeNull();
    expect(makeShortOffer()).toBeInTheDocument();
  });

  it('disables Short recovery controls while confirmation is pending', async () => {
    fetchMock.mockImplementation(hang);
    await openShort(publishingShort('upload outcome unknown'));
    const panel = screen.getByRole('region', { name: 'Upload outcome unknown' });
    const input = within(panel).getByLabelText('Video link');
    const confirm = within(panel).getByRole('button', { name: 'Confirm video' });
    await fireEvent.input(input, { target: { value: 'https://youtu.be/short-video' } });
    await fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(input).toBeDisabled();
    expect(button('Discard')).toBeDisabled();
    expect(paths().filter((path) => path.endsWith('/confirm-upload'))).toEqual([
      '/api/jobs/s1/confirm-upload',
    ]);
  });

  it("keeps the Short's edits through a trip back to the release", async () => {
    fetchMock.mockImplementation(hang);
    await openShort(shortView('REVIEW', {}, { playbackUrl: URL_A }));
    const title = screen.getByRole('textbox', { name: /Title/ });
    await fireEvent.input(title, { target: { value: 'Hook cut' } });
    await fireEvent.click(button(BACK_TO_RELEASE));
    await fireEvent.click(shortOffer());
    expect(screen.getByRole('textbox', { name: /Title/ })).toHaveValue('Hook cut');
  });

  it('pauses a playing video when its room is left', async () => {
    fetchMock.mockImplementation(hang);
    const { container } = await openShort(shortView('REVIEW', {}, { playbackUrl: URL_A }));
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'paused', { value: false });
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
    await fireEvent.click(button(BACK_TO_RELEASE));
    expect(pause).toHaveBeenCalledOnce();
  });

  it('keeps parent and Short recovery fields apart across rooms', async () => {
    fetchMock.mockImplementation(hang);
    setup(
      view(
        { state: 'PUBLISHING', shortId: 's1', destination: CONNECTED, finalFields: FINAL },
        { pick: PICK, wait: 'upload outcome unknown' },
      ),
      { short: publishingShort('upload outcome unknown') },
    );
    const parent = screen.getByRole('region', { name: 'Upload outcome unknown' });
    const input = within(parent).getByLabelText('Video link');
    await fireEvent.input(input, { target: { value: 'https://youtu.be/parent-video' } });
    await fireEvent.click(shortOffer());
    const regions = screen.getAllByRole('region', { name: 'Upload outcome unknown' });
    expect(regions).toHaveLength(1);
    const shortInput = within(regions[0]!).getByLabelText('Video link');
    expect(shortInput).toHaveValue('');
    expect(shortInput.id).not.toBe(input.id);
    const ids = Array.from(document.querySelectorAll('[id]'), (element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Each room keeps what was typed into it.
    await fireEvent.input(shortInput, { target: { value: 'https://youtu.be/short-video' } });
    await fireEvent.click(button(BACK_TO_RELEASE));
    expect(input).toHaveValue('https://youtu.be/parent-video');
    await fireEvent.click(shortOffer());
    expect(shortInput).toHaveValue('https://youtu.be/short-video');
  });

  it('re-cuts, then plays the new render', async () => {
    fetchMock
      .mockResolvedValueOnce(json(shortView('RENDER', { reframe: 'crop' })))
      .mockResolvedValueOnce(
        json(shortView('REVIEW', { reframe: 'crop', renders: 2 }, { playbackUrl: URL_B })),
      );
    const { container } = await openShort(shortView('REVIEW', {}, { playbackUrl: URL_A }));
    expect(container.querySelector('video')).toHaveAttribute('src', URL_A);
    await fireEvent.click(screen.getByRole('radio', { name: 'Center crop' }));
    await fireEvent.click(button('Re-cut'));
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', URL_B));
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/jobs/s1/recut');
    expect(JSON.parse(String(init!.body))).toEqual({
      startSec: 70,
      lengthSec: 30,
      reframe: 'crop',
    });
    expect(paths()).toEqual(['/api/jobs/s1/recut', SHORT_STEP_PATH]);
  });

  it('approves the Short with its own pick version', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(shortView('PUBLISHING', {}, {}, { uploadProgress: { sent: 0, total: 9 } })),
      )
      .mockImplementation(hang);
    setup(verified({ shortId: 's1' }, { ...PICK, version: 3 }), {
      short: shortView('REVIEW', {}, { playbackUrl: URL_A }),
    });
    await fireEvent.click(shortOffer());
    await fireEvent.click(button(APPROVE));
    await waitFor(() => expect(paths()).toContain(SHORT_STEP_PATH));
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/jobs/s1/approve');
    expect(JSON.parse(String(init!.body))).toMatchObject({
      title: PICK.title,
      pickVersion: 1,
      channelId: CONNECTED.channelId,
    });
  });

  it("flags the Short's expired media in the Short room", async () => {
    fetchMock.mockImplementation(hang);
    await openShort(shortView('REVIEW', {}, {}), { shortExpired: true });
    expect(screen.getByRole('note')).toHaveTextContent(/gone from storage/);
  });

  it('shows field errors from a rejected Short approval in the Short room', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: FIX_FIELDS, fields: { tags: "Not in this job's tag list: x" } }, 422),
    );
    await openShort(shortView('REVIEW', {}, { playbackUrl: URL_A }));
    await fireEvent.click(button(APPROVE));
    expect(await screen.findByText(FIX_FIELDS)).toBeInTheDocument();
    expect(screen.getByText("Not in this job's tag list: x")).toBeInTheDocument();
    expect(heading('Is this the hook?')).toBeInTheDocument();
    // The error belongs to the Short room; it doesn't follow Nathan back to the release.
    await fireEvent.click(button(BACK_TO_RELEASE));
    expect(screen.queryByText(FIX_FIELDS)).toBeNull();
  });

  it('re-picks the hook', async () => {
    fetchMock
      .mockResolvedValueOnce(json(shortView('HOOK', { hook: null })))
      .mockImplementation(hang);
    await openShort(shortView('REVIEW', {}, { playbackUrl: URL_A }));
    await fireEvent.click(button('Re-pick hook'));
    await waitFor(() => expect(paths()).toEqual(['/api/jobs/s1/rerun', SHORT_STEP_PATH]));
    expect(chip()).toHaveTextContent('Picking the hook');
  });

  it('discards only the Short and offers a new one, staying on the page', async () => {
    fetchMock.mockResolvedValueOnce(json(shortView('DISCARDED')));
    await openShort(shortView('REVIEW', {}, { playbackUrl: URL_A }));
    await fireEvent.click(button('Discard'));
    expect(await screen.findByRole('button', { name: MAKE_SHORT })).toBeEnabled();
    expect(heading("It's on your channel")).toBeInTheDocument();
    expect(paths()).toEqual(['/api/jobs/s1/discard']);
    expect(h.goto).not.toHaveBeenCalled();
  });

  it('retries a failed Short step', async () => {
    fetchMock.mockResolvedValueOnce(json(shortView('RENDER'))).mockImplementation(hang);
    await openShort(
      shortView(
        'FAILED',
        {},
        {},
        { failedState: 'RENDER', error: 'The rendered Short never reached storage.' },
      ),
    );
    expect(screen.getByText('The rendered Short never reached storage.')).toBeInTheDocument();
    await fireEvent.click(button('Retry'));
    await waitFor(() => expect(paths()).toEqual(['/api/jobs/s1/retry', SHORT_STEP_PATH]));
  });

  it('shows a network failure on a Short action', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await openShort(shortView('REVIEW', {}, { playbackUrl: URL_A }));
    await fireEvent.click(button('Re-pick hook'));
    expect(await screen.findByText('offline')).toBeInTheDocument();
  });

  it('shows a failed Short step request on the release and keeps trying', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ message: 'Internal Error' }, 500))
      .mockImplementation(hang);
    setup(verified({ shortId: 's1' }), { short: shortView('HOOK', { hook: null }) });
    expect(await screen.findByText('Internal Error')).toBeInTheDocument();
    await fireEvent.click(shortOffer());
    expect(screen.getByText('Internal Error')).toBeInTheDocument();
  });

  it('shows a step error for the Short', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        shortView(
          'FAILED',
          {},
          {},
          { failedState: 'HOOK', error: 'The model reply did not parse as a hook.' },
        ),
      ),
    );
    setup(verified({ shortId: 's1' }), { short: shortView('HOOK', { hook: null }) });
    expect(await screen.findByText('The model reply did not parse as a hook.')).toBeInTheDocument();
  });
});

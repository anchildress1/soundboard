import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftKey } from '#lib/draft.js';
import type { ReviewData } from '#lib/review.js';
import { POLL_BACKOFF, UPLOAD_BACKOFF } from '#lib/retry.js';
import type { Chunk, JobState, JobView, Pick, PublicJob, Short, UploadSaved } from '#lib/types.js';
import {
  acquire,
  ALREADY_DONE,
  DISCARDED,
  MOVED,
  REPLACED,
  start,
  stop,
  uploads,
} from '#lib/upload.js';
import Page from '#src/routes/jobs/[id]/+page.svelte';
import { REVIEW } from '../../../../helpers/review';
import { FakeXhr, installUploadFakes, type FakeLocks } from '../../../../helpers/uploads';

const PLAYBACK_URL = 'https://storage.googleapis.com/bkt/uploads/j1?sig=read';
const BUSY = 'model busy';
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

const h = vi.hoisted(() => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: h.goto, invalidateAll: h.invalidateAll }));

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
  artistName: null,
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
  model: 'gemini-4-argon',
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
    uploadSaved?: UploadSaved | null;
    uploadGeneration?: number;
    research?: ReviewData | null;
  } = {},
) {
  return render(Page, {
    props: {
      data: {
        view: v,
        research: extra.research ?? null,
        playbackUrl: extra.playbackUrl === undefined ? PLAYBACK_URL : extra.playbackUrl,
        short: extra.short ?? null,
        shortExpired: extra.shortExpired ?? false,
        expired: extra.expired ?? false,
        approveTo: extra.approveTo === undefined ? CONNECTED : extra.approveTo,
        trace: TRACE,
        channel: null,
        user: null,
        uploadSaved: extra.uploadSaved ?? null,
        uploadGeneration: extra.uploadGeneration ?? 1,
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

let locks: FakeLocks;

beforeEach(() => {
  h.goto.mockReset();
  h.invalidateAll.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  locks = installUploadFakes();
  URL.createObjectURL = vi.fn(() => LOCAL_BLOB);
  URL.revokeObjectURL = vi.fn();
  localStorage.clear();
});

afterEach(() => {
  stop('j1');
  vi.unstubAllGlobals();
});

describe('job page: working screens', () => {
  it('keeps the model clock counting while the pick runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      fetchMock.mockImplementation(hang);
      setup(view({ state: 'PICK' }, { pick: PICK, chunks: [chunk(0)] }));
      // A re-run keeps the earlier pick's 12s and counts the new call on top.
      expect(screen.getByText('Total model time: 16s')).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(3000);
      expect(screen.getByText('Total model time: 19s')).toBeInTheDocument();
      expect(heading('Drafting the title, description, and tags')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count while the model is busy', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      fetchMock.mockImplementation(hang);
      setup(view({ state: 'PICK' }, { chunks: [chunk(0)], wait: BUSY }));
      await vi.advanceTimersByTimeAsync(3000);
      expect(screen.getByText('Total model time: 4s')).toBeInTheDocument();
      expect(heading('Model busy')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows chunk progress, what it heard, and drives the next step with the job trace', async () => {
    fetchMock.mockImplementation(hang);
    setup(
      view(
        { state: 'ANALYZE', chunkIndex: 1, chunkCount: 5 },
        { chunks: [chunk(0)], model: 'gemini-3.8-flash' },
      ),
    );
    expect(chip()).toHaveTextContent('Window 2 of 5');
    expect(screen.getByText('Configured analyst: gemini-3.8-flash')).toBeInTheDocument();
    expect(screen.getByText('Total model time: 4s')).toBeInTheDocument();
    expect(heading('Listening to the video')).toBeInTheDocument();
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

  it('links Settings while the pick waits on an artist profile', async () => {
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'PICK' }, { wait: 'Add your artist name first.' })))
      .mockImplementation(hang);
    setup(view({ state: 'PICK' }));
    expect(
      await screen.findByRole('link', { name: 'Add your artist name in Settings' }),
    ).toHaveAttribute('href', '/settings');
  });

  it('links Connections while the pick waits on a reconnect, and only during the pick', async () => {
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'PICK' }, { wait: 'reconnect YouTube' })))
      .mockImplementation(hang);
    const { unmount } = setup(view({ state: 'PICK' }));
    expect(
      await screen.findByRole('link', { name: 'Reconnect YouTube on Connections' }),
    ).toHaveAttribute('href', '/connections');
    unmount();
    fetchMock.mockReset().mockImplementation(hang);
    setup(view({ state: 'ANALYZE', chunkIndex: 0 }, { wait: BUSY }));
    expect(screen.queryByRole('link', { name: 'Reconnect YouTube on Connections' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add your artist name in Settings' })).toBeNull();
  });

  it('shows a named wait from the step', async () => {
    fetchMock
      .mockResolvedValueOnce(json(view({ state: 'ANALYZE', chunkIndex: 0 }, { wait: BUSY })))
      .mockImplementation(hang);
    setup(view({ state: 'ANALYZE', chunkIndex: 0 }));
    // The headline names the wait once; the status row keeps showing progress.
    await waitFor(() => expect(heading('Model busy')).toBeInTheDocument());
    expect(chip()).toHaveTextContent('Window 1 of 5');
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

  it('keeps the edits when an approval fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    setup(view({ state: 'REVIEW' }, { pick: PICK }));
    await fireEvent.input(titleInput(), { target: { value: 'Edited' } });
    await toApprove();
    await fireEvent.click(button(APPROVE));
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
    expect(heading(APPROVE_SCREEN)).toBeInTheDocument();
    expect(localStorage.getItem(draftKey('j1', 1))).toContain('Edited');
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

describe('job page: evidence', () => {
  const reviewing = (research: ReviewData | null = REVIEW) =>
    setup(view({ state: 'REVIEW' }, { pick: PICK }), { research });

  it('shows the recommendation and peers on the approval screen', async () => {
    reviewing();
    expect(screen.queryByRole('heading', { name: 'Recommendation' })).toBeNull();
    await toApprove();
    expect(screen.getByRole('heading', { name: 'Recommendation' })).toBeInTheDocument();
    expect(screen.getByText('Similar artists (2)')).toBeInTheDocument();
  });

  it('shows the cited sources under Why this', () => {
    reviewing();
    expect(screen.getByText('Sources: P1-R1 · Night Drive')).toBeInTheDocument();
  });

  it('shows neither for a pick with no evidence data', async () => {
    reviewing(null);
    await toApprove();
    expect(screen.queryByRole('heading', { name: 'Recommendation' })).toBeNull();
    expect(screen.queryByText(/Similar artists/)).toBeNull();
    expect(screen.queryByText(/^Sources:/)).toBeNull();
  });

  it('removes a peer after Not a peer is recorded', async () => {
    fetchMock.mockResolvedValueOnce(json({ rejected: 'P2' }));
    reviewing();
    await toApprove();
    await fireEvent.click(screen.getAllByRole('button', { name: 'Not a peer' })[1]!);
    await waitFor(() => expect(screen.queryByText('Quiet Signal')).toBeNull());
    expect(screen.getByText('Neon Harbor')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/jobs/j1/peers/P2/reject');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });

  it('keeps the peer and shows why when the evidence has expired', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: "That peer's evidence has expired. Reload to see it." }, 409),
    );
    reviewing();
    await toApprove();
    await fireEvent.click(screen.getAllByRole('button', { name: 'Not a peer' })[0]!);
    expect(
      await screen.findByText("That peer's evidence has expired. Reload to see it."),
    ).toBeInTheDocument();
    expect(screen.getByText('Neon Harbor')).toBeInTheDocument();
  });

  it('does not ask for any extra step to approve', async () => {
    reviewing();
    await toApprove();
    expect(button(APPROVE)).toBeEnabled();
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
    await waitFor(() => expect(chip()).toHaveTextContent('Window 3 of 5'));
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
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/', { refreshAll: true }));
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
    expect(chip()).toHaveTextContent('Upload outcome unknown');
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

describe('job page: browser upload', () => {
  const SESSION = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?upload_id=s1';
  const file = new File(['0123456789'], 'peekaboo.mp4', { type: 'video/mp4' });
  const awaitingView = () => view({ state: 'AWAITING_UPLOAD', chunkCount: 0, chunkIndex: 0 });
  const prep = () => view({ state: 'PREP', chunkCount: 0, chunkIndex: 0 });

  /** Upload-session confirms pass; each step answers the next of `steps`, then never again. */
  const serveUpload = (...steps: JobView[]) => {
    const queue = [...steps];
    fetchMock.mockImplementation(async (path) => {
      if (String(path).endsWith('/upload-session')) return json({ current: true });
      const next = queue.shift();
      return next ? json(next) : hang();
    });
  };
  const steps = () => paths().filter((path) => path === STEP_PATH);

  /** The file /new handed over: the uploader is already running in this tab. */
  const handedOver = async () => {
    await acquire('j1');
    start('j1', { file, sessionUri: SESSION, generation: 1, fingerprint: 'f'.repeat(64) });
  };
  const query = async () => {
    await waitFor(() => expect(FakeXhr.all.at(-1)?.headers['content-range']).toMatch(/^bytes \*/));
    return FakeXhr.all.at(-1)!;
  };

  it('plays the handed-over file and shows what the upload sent', async () => {
    serveUpload();
    await handedOver();
    const { container, unmount } = setup(awaitingView(), { playbackUrl: null });
    expect(heading('Uploading your video')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 8 · Upload')).toBeInTheDocument();
    expect(container.querySelector('video')).toHaveAttribute('src', LOCAL_BLOB);
    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
    (await query()).respond(308, { range: 'bytes=0-1' });
    await waitFor(() => expect(chip()).toHaveTextContent('Uploading 20%'));
    FakeXhr.all.at(-1)!.progress(3);
    await waitFor(() => expect(chip()).toHaveTextContent('Uploading 50%'));
    expect(steps()).toEqual([]);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(LOCAL_BLOB);
  });

  it.each([
    [503, 'Upload paused: storage busy, retrying'],
    [429, 'Upload paused: storage busy, retrying'],
    [408, 'Upload paused: no connection'],
  ])('names a pause on %i, never as an error', async (status, text) => {
    serveUpload();
    await handedOver();
    setup(awaitingView(), { playbackUrl: null });
    (await query()).respond(status);
    await waitFor(() => expect(chip()).toHaveTextContent(text));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('pauses as no connection on a drop', async () => {
    serveUpload();
    await handedOver();
    setup(awaitingView(), { playbackUrl: null });
    (await query()).drop();
    await waitFor(() => expect(chip()).toHaveTextContent('Upload paused: no connection'));
  });

  it('looks for the landed upload, then drives the steps', async () => {
    serveUpload(prep());
    await handedOver();
    setup(awaitingView(), { playbackUrl: null });
    (await query()).respond(200);
    await waitFor(() => expect(chip()).toHaveTextContent('Measuring audio'));
    expect(heading('Measuring the audio')).toBeInTheDocument();
    expect(locks.holders.size).toBe(0);
  });

  it('looks again with backoff until the upload lands', async () => {
    serveUpload(awaitingView(), prep());
    await handedOver();
    setup(awaitingView(), { playbackUrl: null });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      (await query()).respond(200);
      await vi.advanceTimersByTimeAsync(0);
      expect(steps()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(POLL_BACKOFF.minTimeout);
      expect(chip()).toHaveTextContent('Measuring audio');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps looking while storage is slow to show the landed upload', async () => {
    serveUpload(...Array.from({ length: 6 }, awaitingView), prep());
    await handedOver();
    setup(awaitingView(), { playbackUrl: null });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      (await query()).respond(200);
      await vi.advanceTimersByTimeAsync(10 * POLL_BACKOFF.maxTimeout);
      expect(chip()).toHaveTextContent('Measuring audio');
      // Seven looks to land, then the driver's first step.
      expect(steps()).toHaveLength(8);
      expect(screen.queryByText(/failed/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads the page data for a playback URL once the upload moved on', async () => {
    serveUpload(prep());
    await handedOver();
    setup(awaitingView(), { playbackUrl: null });
    (await query()).respond(200);
    await waitFor(() => expect(chip()).toHaveTextContent('Measuring audio'));
    expect(h.invalidateAll).toHaveBeenCalledTimes(1);
  });

  it('stops looking for the upload once the page is left', async () => {
    serveUpload(...Array.from({ length: 5 }, awaitingView));
    await handedOver();
    const { unmount } = setup(awaitingView(), { playbackUrl: null });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      (await query()).respond(200);
      await vi.advanceTimersByTimeAsync(0);
      expect(steps()).toHaveLength(1);
      unmount();
      await vi.runAllTimersAsync();
      expect(steps()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Step replies in order, then none; upload-session confirms pass. */
  const serveSteps = (...replies: (() => Promise<Response>)[]) => {
    fetchMock.mockImplementation(async (path) => {
      if (String(path).endsWith('/upload-session')) return json({ current: true });
      return (replies.shift() ?? hang)();
    });
  };

  // Safari's 'Load failed' carries the stack Sentry's fetch wrapper backfills, as a Node error does.
  it.each(['Failed to fetch', 'Load failed'])(
    'asks again after a step with no reply (%s) or a 5xx, showing the error until it lands',
    async (dropped) => {
      serveSteps(
        () => Promise.reject(new TypeError(dropped)),
        async () => json({ error: 'Internal' }, 503),
        async () => json(prep()),
      );
      await handedOver();
      setup(awaitingView(), { playbackUrl: null });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        (await query()).respond(200);
        await vi.advanceTimersByTimeAsync(0);
        expect(screen.getByText(dropped)).toBeInTheDocument();
        await vi.advanceTimersByTimeAsync(POLL_BACKOFF.minTimeout);
        expect(screen.getByText('Internal')).toBeInTheDocument();
        await vi.advanceTimersByTimeAsync(POLL_BACKOFF.minTimeout * POLL_BACKOFF.factor);
        // Three tries to land, then the driver's first step.
        expect(steps()).toHaveLength(4);
        expect(chip()).toHaveTextContent('Measuring audio');
        expect(screen.queryByText('Internal')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('stops looking on a 4xx step reply and shows it', async () => {
    serveSteps(async () => json({ error: 'Not found' }, 404));
    await handedOver();
    setup(awaitingView(), { playbackUrl: null });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      (await query()).respond(200);
      await vi.runAllTimersAsync();
      expect(steps()).toHaveLength(1);
      expect(screen.getByText('Not found')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the message an upload stopped on', async () => {
    serveUpload();
    await handedOver();
    setup(awaitingView(), { playbackUrl: null });
    (await query()).respond(403);
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed (403)');
    expect(steps()).toEqual([]);
  });

  it('moves a job on after a reload when the upload already landed', async () => {
    serveUpload(prep());
    setup(awaitingView(), {
      playbackUrl: null,
      uploadSaved: { saved: 10, total: 10, done: true },
    });
    await waitFor(() => expect(chip()).toHaveTextContent('Measuring audio'));
    expect(screen.queryByLabelText(/Pick the video/)).toBeNull();
  });

  it('asks for the file after a reload, with the saved amount when storage said it', () => {
    serveUpload();
    const { unmount } = setup(awaitingView(), {
      playbackUrl: null,
      uploadSaved: { saved: 299, total: 1000, done: false },
    });
    expect(chip()).toHaveTextContent('Upload paused at 29%. Pick the video to continue.');
    unmount();
    setup(awaitingView(), { playbackUrl: null });
    expect(chip()).toHaveTextContent('Pick the video to continue.');
    expect(steps()).toEqual([]);
  });

  describe('away', () => {
    const AWAY = 'The upload paused while you were away.';
    const visibility = (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    afterEach(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });

    it('names a pause that happened while away, with the saved amount, and resumes', async () => {
      serveUpload();
      await handedOver();
      setup(awaitingView(), { playbackUrl: null });
      (await query()).respond(308, { range: 'bytes=0-2' });
      await waitFor(() => expect(chip()).toHaveTextContent('Uploading 30%'));
      FakeXhr.all.at(-1)!.drop();
      await waitFor(() => expect(chip()).toHaveTextContent('Upload paused: no connection'));
      const before = FakeXhr.all.length;
      visibility('hidden');
      visibility('visible');
      await waitFor(() => expect(chip()).toHaveTextContent(AWAY));
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
      await waitFor(() => expect(FakeXhr.all.length).toBeGreaterThan(before));
    });

    it('shows nothing new when bytes went out while hidden', async () => {
      serveUpload();
      await handedOver();
      setup(awaitingView(), { playbackUrl: null });
      (await query()).respond(308);
      await waitFor(() => expect(FakeXhr.all.at(-1)?.isQuery).toBe(false));
      visibility('hidden');
      FakeXhr.all.at(-1)!.progress(5);
      visibility('visible');
      await waitFor(() => expect(chip()).toHaveTextContent('Uploading 50%'));
      expect(screen.queryByText(AWAY)).toBeNull();
    });

    it('drives the step at once when the upload finished while the page was away', async () => {
      serveUpload(prep());
      await handedOver();
      (await query()).respond(200);
      setup(awaitingView(), { playbackUrl: null });
      await waitFor(() => expect(chip()).toHaveTextContent('Measuring audio'));
    });
  });
});

describe('job page: picking the video again', () => {
  const SESSION = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?upload_id=s2';
  const SESSION_PATH = '/api/jobs/j1/upload-session';
  const PICK_PROMPT = 'Pick the video to continue.';
  const UNREADABLE = "Couldn't read this video. Pick it again.";
  const OTHER_TAB = 'Uploading in another tab';
  const video = new File(['0123456789'], 'peekaboo.mp4', { type: 'video/mp4' });
  const awaitingView = () => view({ state: 'AWAITING_UPLOAD', chunkCount: 0, chunkIndex: 0 });
  const picked = { sessionUri: SESSION, generation: 2, restarted: false };

  type Answer = Response | (() => Promise<Response>);
  /** Each upload-session call takes the next answer; the last one repeats. Steps hang. */
  const serve = (...answers: Answer[]) => {
    fetchMock.mockImplementation(async (path) => {
      if (!String(path).endsWith('/upload-session')) return hang();
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
      return typeof answer === 'function' ? answer() : answer.clone();
    });
  };
  const bodies = () =>
    fetchMock.mock.calls
      .filter(([path]) => String(path) === SESSION_PATH)
      .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>);
  const picks = () => bodies().filter((body) => body.op === 'pick');
  const filePicker = () => screen.queryByLabelText('Pick the video') as HTMLInputElement | null;

  /** Picks `file`; `duration` null leaves the video unplayable, so it errors. */
  const pick = async (container: HTMLElement, file = video, duration: number | null = 140) => {
    await fireEvent.change(filePicker()!, { target: { files: [file] } });
    const el = container.querySelector('video')!;
    if (duration === null) {
      await fireEvent.error(el);
      return;
    }
    Object.defineProperty(el, 'duration', { configurable: true, get: () => duration });
    await fireEvent(el, new Event('durationchange'));
  };

  /** Another tab holds the job's lock until the returned release runs. */
  const otherTab = () => {
    let release!: () => void;
    void locks.request('upload:j1', {}, () => new Promise<void>((done) => (release = done)));
    return () => release();
  };

  it('reads the file, takes the lock, then resumes under the newest generation', async () => {
    serve(json(picked), json({ current: true }));
    const { container } = setup(awaitingView(), {
      playbackUrl: null,
      uploadSaved: { saved: 4, total: 10, done: false },
      uploadGeneration: 2,
    });
    expect(chip()).toHaveTextContent('Upload paused at 40%. Pick the video to continue.');
    await pick(container);
    await waitFor(() => expect(picks()).toHaveLength(1));
    expect(picks()[0]).toEqual({
      op: 'pick',
      opId: expect.any(String),
      generation: 2,
      size: 10,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      filename: 'peekaboo.mp4',
      contentType: 'video/mp4',
      durationSec: 140,
    });
    expect(locks.holders).toEqual(new Set(['upload:j1']));
    await waitFor(() => expect(FakeXhr.all.at(-1)?.url).toBe(SESSION));
    expect(filePicker()).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('says the upload starts over when the server restarted it for a new video', async () => {
    serve(json({ ...picked, restarted: true }), json({ current: true }));
    const { container } = setup(awaitingView(), { playbackUrl: null });
    await pick(container, new File(['x'], 'other.webm', { type: '' }));
    expect(await screen.findByRole('note')).toHaveTextContent(
      'New video: starting the upload over.',
    );
    expect(picks()[0]).toMatchObject({ contentType: 'video/mp4', filename: 'other.webm' });
  });

  it('asks again when the video cannot play, with no lock and no request', async () => {
    serve(json(picked));
    const { container } = setup(awaitingView(), { playbackUrl: null });
    await pick(container, video, null);
    await waitFor(() => expect(chip()).toHaveTextContent(UNREADABLE));
    expect(filePicker()).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(locks.holders.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks again when the video gives no duration within 15 s', async () => {
    serve(json(picked));
    const { container } = setup(awaitingView(), { playbackUrl: null });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await fireEvent.change(filePicker()!, { target: { files: [video] } });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(chip()).toHaveTextContent(PICK_PROMPT);
      await vi.advanceTimersByTimeAsync(1);
      expect(chip()).toHaveTextContent(UNREADABLE);
    } finally {
      vi.useRealTimers();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('video')).toBeNull();
  });

  it('asks again when the file cannot be read for its fingerprint', async () => {
    serve(json(picked));
    vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValueOnce(
      new DOMException('The file could not be read.', 'NotReadableError'),
    );
    const { container } = setup(awaitingView(), { playbackUrl: null });
    await pick(container);
    await waitFor(() => expect(chip()).toHaveTextContent(UNREADABLE));
    expect(locks.holders.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resends the same pick after a timeout or a 503, backing off', async () => {
    const timedOut = () => Promise.reject(new DOMException('signal timed out', 'TimeoutError'));
    serve(timedOut, json({ error: 'busy' }, 503), json(picked), json({ current: true }));
    const { container } = setup(awaitingView(), { playbackUrl: null });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await pick(container);
      await vi.waitFor(() => expect(picks()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(UPLOAD_BACKOFF.minTimeout);
      expect(picks()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(UPLOAD_BACKOFF.minTimeout * UPLOAD_BACKOFF.factor);
      expect(picks()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
    expect(new Set(picks().map((body) => body.opId)).size).toBe(1);
    await waitFor(() => expect(FakeXhr.all.at(-1)?.url).toBe(SESSION));
  });

  it('shows a refused pick, lets the lock go and keeps the picker', async () => {
    serve(json({ error: "This video doesn't match the size of the saved upload." }, 400));
    const { container } = setup(awaitingView(), { playbackUrl: null });
    await pick(container);
    expect(await screen.findByRole('alert')).toHaveTextContent("doesn't match the size");
    await waitFor(() => expect(locks.holders.size).toBe(0));
    expect(filePicker()).not.toBeNull();
    expect(get(uploads).j1).toBeUndefined();
  });

  it.each([
    [REPLACED, 'A different video replaced this upload.'],
    [MOVED, 'The upload moved to another device or window.'],
  ])('names a 409 "%s" and picks next under its generation', async (error, text) => {
    serve(json({ error, generation: 5 }, 409));
    const { container } = setup(awaitingView(), { playbackUrl: null });
    await pick(container);
    await waitFor(() => expect(chip()).toHaveTextContent(text));
    await waitFor(() => expect(locks.holders.size).toBe(0));
    expect(screen.queryByRole('alert')).toBeNull();
    await pick(container);
    await waitFor(() => expect(picks()).toHaveLength(2));
    expect(picks()[1]!.generation).toBe(5);
  });

  it('moves the job on when the pick finds the upload already done', async () => {
    fetchMock.mockImplementation(async (path) =>
      String(path).endsWith('/upload-session')
        ? json({ error: ALREADY_DONE, generation: 1 }, 409)
        : json(view({ state: 'PREP', chunkCount: 0, chunkIndex: 0 })),
    );
    const { container } = setup(awaitingView(), { playbackUrl: null });
    await pick(container);
    await waitFor(() => expect(chip()).toHaveTextContent('Measuring audio'));
  });

  it('reloads the job when the pick finds it discarded', async () => {
    serve(json({ error: DISCARDED, generation: 1 }, 409));
    const { container } = setup(awaitingView(), { playbackUrl: null });
    await pick(container);
    await waitFor(() => expect(h.invalidateAll).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reloads the job when a running upload hears it was discarded', async () => {
    serve(json(picked), json({ error: DISCARDED, generation: 2 }, 409));
    const { container } = setup(awaitingView(), { playbackUrl: null });
    await pick(container);
    await waitFor(() => expect(h.invalidateAll).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('waits on another tab, then takes over and asks for the file', async () => {
    const release = otherTab();
    serve(json(picked));
    setup(awaitingView(), { playbackUrl: null });
    await waitFor(() => expect(chip()).toHaveTextContent(OTHER_TAB));
    expect(filePicker()).toBeNull();
    release();
    await waitFor(() => expect(h.invalidateAll).toHaveBeenCalledTimes(1));
    expect(chip()).toHaveTextContent(PICK_PROMPT);
    expect(filePicker()).not.toBeNull();
    expect(locks.holders).toEqual(new Set(['upload:j1']));
  });

  it('moves the job on when the upload landed before the takeover', async () => {
    const release = otherTab();
    fetchMock.mockImplementation(async () =>
      json(view({ state: 'PREP', chunkCount: 0, chunkIndex: 0 })),
    );
    const { rerender } = setup(awaitingView(), { playbackUrl: null });
    await waitFor(() => expect(chip()).toHaveTextContent(OTHER_TAB));
    h.invalidateAll.mockImplementation(async () => {
      await rerender({
        data: {
          view: awaitingView(),
          playbackUrl: null,
          short: null,
          shortExpired: false,
          expired: false,
          approveTo: CONNECTED,
          trace: TRACE,
          channel: null,
          user: null,
          uploadSaved: { saved: 10, total: 10, done: true },
          uploadGeneration: 1,
        },
      } as never);
    });
    release();
    await waitFor(() => expect(chip()).toHaveTextContent('Measuring audio'));
  });

  it('shows the other tab when a pick finds the lock taken', async () => {
    serve(json(picked));
    const { container } = setup(awaitingView(), { playbackUrl: null });
    otherTab();
    await pick(container);
    await waitFor(() => expect(chip()).toHaveTextContent(OTHER_TAB));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets the lock go when the page closes with no upload running', async () => {
    const release = otherTab();
    serve(json(picked));
    const { unmount } = setup(awaitingView(), { playbackUrl: null });
    await waitFor(() => expect(chip()).toHaveTextContent(OTHER_TAB));
    release();
    await waitFor(() => expect(locks.holders).toEqual(new Set(['upload:j1'])));
    unmount();
    await waitFor(() => expect(locks.holders.size).toBe(0));
  });

  it('keeps a running upload going when the page closes', async () => {
    serve(json(picked), json({ current: true }));
    const { container, unmount } = setup(awaitingView(), { playbackUrl: null });
    await pick(container);
    await waitFor(() => expect(FakeXhr.all.at(-1)?.url).toBe(SESSION));
    unmount();
    expect(locks.holders).toEqual(new Set(['upload:j1']));
    expect(get(uploads).j1?.state).toBe('sending');
  });
});

describe('job page: discard during the upload', () => {
  const SESSION = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?upload_id=s1';
  const DISCARD_PATH = '/api/jobs/j1/discard';
  const file = new File(['0123456789'], 'peekaboo.mp4', { type: 'video/mp4' });
  const awaitingView = () => view({ state: 'AWAITING_UPLOAD', chunkCount: 0, chunkIndex: 0 });

  const serve = (discard: Response) =>
    fetchMock.mockImplementation(async (path) => {
      if (String(path) === DISCARD_PATH) return discard;
      if (String(path).endsWith('/upload-session')) return json({ current: true });
      return hang();
    });
  const sending = async () => {
    await acquire('j1');
    start('j1', { file, sessionUri: SESSION, generation: 1, fingerprint: 'f'.repeat(64) });
  };

  it.each([
    ['sending', sending],
    ['waiting for a pick', async () => {}],
    [
      'waiting on another tab',
      async () => {
        void locks.request('upload:j1', {}, () => new Promise<void>(() => {}));
      },
    ],
  ])('offers Discard while the upload is %s', async (_, arrange) => {
    serve(json(view({ state: 'DISCARDED' })));
    await arrange();
    setup(awaitingView(), { playbackUrl: null });
    expect(button('Discard')).toBeEnabled();
  });

  it('offers no Discard while a model step runs', () => {
    fetchMock.mockImplementation(hang);
    setup(view({ state: 'PREP', chunkCount: 0, chunkIndex: 0 }));
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('stops the upload before the discard request, then leaves', async () => {
    let sendingAtDiscard: boolean | null = null;
    fetchMock.mockImplementation(async (path) => {
      if (String(path) === DISCARD_PATH) {
        sendingAtDiscard = get(uploads).j1 !== undefined;
        return json(view({ state: 'DISCARDED' }));
      }
      if (String(path).endsWith('/upload-session')) return json({ current: true });
      return hang();
    });
    await sending();
    setup(awaitingView(), { playbackUrl: null });
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    await fireEvent.click(button('Discard'));
    await waitFor(() => expect(h.goto).toHaveBeenCalledWith('/'));
    expect(sendingAtDiscard).toBe(false);
    expect(FakeXhr.all[0]!.aborted).toBe(true);
    expect(locks.holders.size).toBe(0);
  });

  it('shows a refused discard and keeps the job', async () => {
    serve(json({ error: 'Storage is busy. Try discarding again.' }, 503));
    await sending();
    setup(awaitingView(), { playbackUrl: null });
    await fireEvent.click(button('Discard'));
    expect(await screen.findByText('Storage is busy. Try discarding again.')).toBeInTheDocument();
    expect(h.goto).not.toHaveBeenCalled();
    expect(heading('Uploading your video')).toBeInTheDocument();
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
  model: 'gemini-4-argon',
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

  it.each([
    ['FAILED', { failedState: 'PUBLISHING' }],
    ['DISCARDED', {}],
  ] as [JobState, Partial<PublicJob>][])(
    'keeps an existing Short reachable once its video stops (%s)',
    async (state, patch) => {
      fetchMock.mockImplementation(hang);
      setup(view({ state, finalFields: FINAL, shortId: 's1', ...patch }, { pick: PICK }), {
        short: shortView('REVIEW', {}, { playbackUrl: URL_A }),
      });
      expect(screen.queryByRole('button', { name: MAKE_SHORT })).toBeNull();
      expect(screen.queryByRole('button', { name: /Put it on Bandcamp/ })).toBeNull();
      await fireEvent.click(shortOffer());
      expect(heading('Is this the hook?')).toBeInTheDocument();
    },
  );

  it('offers nothing after a stopped video without a Short', () => {
    fetchMock.mockImplementation(hang);
    setup(view({ state: 'DISCARDED', finalFields: FINAL }, { pick: PICK }));
    expect(screen.queryByRole('heading', { name: OFFERS })).toBeNull();
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

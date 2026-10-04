import { fireEvent, render, screen, within } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import Short from '$lib/components/Short.svelte';
import type { JobState, JobView, Pick, PublicJob, Short as ShortSpec } from '$lib/types';

const INVALID = 'aria-invalid';

const SPEC: ShortSpec = {
  parentId: 'p1',
  sourceDurationSec: 180,
  reframe: 'blur',
  hook: { window: 2, startSec: 70, lengthSec: 30, reason: 'The chorus lands with the full band.' },
  skipped: [],
  renders: 1,
  modelMs: 6_400,
};

const PICK: Pick = {
  version: 1,
  title: 'PeekaBoo (Official Video)',
  description: 'Night drive.\n\n#synthwave',
  hashtags: ['#synthwave'],
  tags: ['synthwave'],
  flags: [],
  brandCheck: '',
  why: { title: '', description: '', tags: '' },
  bandcamp: { about: '', credits: '' },
  modelMs: 12_000,
};

const view = (
  state: JobState = 'REVIEW',
  spec: Partial<ShortSpec> = {},
  job: Partial<PublicJob> = {},
  extra: Partial<JobView> = {},
): JobView => ({
  job: {
    id: 's1',
    state,
    owner: 'visitor',
    channel: 'sandbox',
    songTitle: 'PeekaBoo',
    notes: '',
    filename: 'peekaboo (Short).mp4',
    sampleId: null,
    probe: { durationSec: 30, width: 720, height: 1280, hasAudio: true },
    measurements: null,
    chunkCount: 0,
    chunkIndex: 0,
    failedState: null,
    error: null,
    uploadProgress: null,
    videoId: null,
    payload: null,
    hashtagCandidates: ['#synthwave'],
    shortId: null,
    short: { ...SPEC, ...spec },
    createdAt: 1,
    ...job,
  },
  chunks: [],
  pick: PICK,
  ...extra,
});

function setup(props: Partial<ComponentProps<typeof Short>> = {}) {
  const handlers = {
    onrecut: vi.fn(),
    onapprove: vi.fn(),
    onrerun: vi.fn(),
    ondiscard: vi.fn(),
    onretry: vi.fn(),
  };
  const utils = render(Short, {
    view: view(),
    src: 'https://storage.googleapis.com/bkt/uploads/s1-1?sig=read',
    ...handlers,
    ...props,
  });
  return { ...utils, ...handlers };
}

const start = () => screen.getByLabelText(/^Start/) as HTMLInputElement;
const length = () => screen.getByLabelText(/^Length/) as HTMLInputElement;
const recut = () => screen.getByRole('button', { name: 'Re-cut' });

describe('Short: running', () => {
  it('names the hook pick on the chip and shows no cut yet', () => {
    const { container } = setup({
      view: view('HOOK', { hook: null, renders: 0, modelMs: 0 }),
      src: null,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Picking the hook');
    expect(screen.queryByRole('heading', { name: 'Cut' })).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText('gemma-4-12b-it')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve & upload' })).toBeNull();
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).readOnly).toBe(true);
  });

  it('names the render on the chip and locks the cut while it runs', () => {
    setup({ view: view('RENDER') });
    expect(screen.getByRole('status')).toHaveTextContent('Cutting the Short');
    expect(start()).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Blur fill' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Re-cut' })).toBeNull();
  });

  it('shows the named wait while the model wakes', () => {
    setup({ view: view('HOOK', { hook: null }, {}, { wait: 'waking model' }) });
    expect(screen.getByRole('status')).toHaveTextContent('waking model');
  });
});

describe('Short: review', () => {
  it('plays the render in a vertical frame with the hook, its reason, and the model time', () => {
    const { container } = setup();
    const video = container.querySelector('video')!;
    expect(video).toHaveAttribute(
      'src',
      'https://storage.googleapis.com/bkt/uploads/s1-1?sig=read',
    );
    expect(container.querySelector('.monitor')).toHaveClass('vertical');
    expect(screen.getByText('00:01:10 – 00:01:40 · 30s')).toBeInTheDocument();
    expect(screen.getByText(/The chorus lands with the full band\./)).toBeInTheDocument();
    expect(screen.getByText('gemma-4-12b-it · 6s')).toBeInTheDocument();
    expect(screen.getByText('720p · vertical')).toBeInTheDocument();
  });

  it('hides the reason once the artist moved the cut', () => {
    setup({ view: view('REVIEW', { hook: { ...SPEC.hook!, reason: '' } }) });
    expect(screen.queryByText('Why this hook')).toBeNull();
  });

  it('fills the cut form from the hook, with Re-cut off until something changes', () => {
    setup();
    expect(start().value).toBe('70');
    expect(length().value).toBe('30');
    expect(screen.getByRole('radio', { name: 'Blur fill' })).toBeChecked();
    expect(recut()).toBeDisabled();
  });

  it('re-cuts with a new framing', async () => {
    const { onrecut } = setup();
    await fireEvent.click(screen.getByRole('radio', { name: 'Center crop' }));
    expect(recut()).toBeEnabled();
    await fireEvent.click(recut());
    expect(onrecut).toHaveBeenCalledWith({ startSec: 70, lengthSec: 30, reframe: 'crop' });
  });

  it('re-cuts with a new start and length, rounded to a tenth', async () => {
    const { onrecut } = setup();
    await fireEvent.input(start(), { target: { value: '81.24' } });
    await fireEvent.input(length(), { target: { value: '22.06' } });
    await fireEvent.click(recut());
    expect(onrecut).toHaveBeenCalledWith({ startSec: 81.2, lengthSec: 22.1, reframe: 'blur' });
  });

  it('flags a length out of bounds on the field and blocks the re-cut', async () => {
    const { onrecut } = setup();
    await fireEvent.input(length(), { target: { value: '75' } });
    expect(length()).toHaveAttribute(INVALID, 'true');
    expect(length()).toHaveAccessibleDescription('Length must be 15 to 60 seconds.');
    expect(recut()).toBeDisabled();
    await fireEvent.submit(recut().closest('form')!);
    expect(onrecut).not.toHaveBeenCalled();
  });

  it('flags a start that runs past the end', async () => {
    setup();
    await fireEvent.input(start(), { target: { value: '160' } });
    expect(start()).toHaveAccessibleDescription('Start must be 0 to 150 seconds for that length.');
    expect(start()).toHaveAttribute(INVALID, 'true');
    expect(length()).not.toHaveAttribute(INVALID);
  });

  it('flags an emptied field instead of cutting at zero', async () => {
    setup();
    await fireEvent.input(length(), { target: { value: '' } });
    expect(length()).toHaveAttribute(INVALID, 'true');
    expect(recut()).toBeDisabled();
  });

  it('names the length bounds for a 30-second sample', () => {
    setup({
      view: view('REVIEW', {
        sourceDurationSec: 30,
        hook: { ...SPEC.hook!, startSec: 0, lengthSec: 30 },
      }),
    });
    expect(screen.getByText('15–30 s')).toBeInTheDocument();
    expect(length()).toHaveAttribute('max', '30');
  });

  it('blocks the re-cut while an action is running', async () => {
    setup({ busy: true });
    await fireEvent.click(screen.getByRole('radio', { name: 'Center crop' }));
    expect(recut()).toBeDisabled();
  });

  it('edits and approves the Short metadata in its own label', async () => {
    const { onapprove, onrerun, ondiscard } = setup();
    const label = screen.getByRole('region', { name: 'YouTube Short' });
    expect(within(label).getByLabelText(/^Title/)).toHaveAttribute('id', 'short-title');
    await fireEvent.click(within(label).getByRole('button', { name: 'Re-pick hook' }));
    await fireEvent.click(within(label).getByRole('button', { name: 'Discard' }));
    await fireEvent.click(within(label).getByRole('button', { name: 'Approve & upload' }));
    expect(onrerun).toHaveBeenCalledOnce();
    expect(ondiscard).toHaveBeenCalledOnce();
    expect(onapprove).toHaveBeenCalledWith({
      title: PICK.title,
      description: PICK.description,
      tags: PICK.tags,
    });
  });

  it('shows server field errors on the label', () => {
    setup({ serverErrors: { title: 'Title is over 100 characters.' } });
    expect(screen.getByText('Title is over 100 characters.')).toBeInTheDocument();
  });

  it('announces messages politely', () => {
    setup({ message: 'A newer recommendation replaced this one.' });
    expect(screen.getByText('A newer recommendation replaced this one.')).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });
});

describe('Short: after approval', () => {
  it('shows the would-be payload when there is no channel to upload to', () => {
    const payload = { title: 'Edited', description: 'd', hashtags: [], tags: [] };
    setup({ view: view('PAYLOAD', {}, { payload }) });
    expect(screen.getByRole('region', { name: 'Would-be upload payload' })).toBeInTheDocument();
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Edited');
    expect(start()).toBeDisabled();
  });

  it('marks the upload done while publishing', () => {
    setup({ view: view('PUBLISHING', {}, { uploadProgress: { sent: 5, total: 10 } }) });
    expect(screen.getByRole('status')).toHaveTextContent('Uploading to YouTube 50%');
    expect(screen.getByRole('button', { name: 'Uploaded' })).toBeDisabled();
  });

  it('links the verified upload', () => {
    setup({ view: view('VERIFIED', {}, { videoId: 'abc123' }) });
    expect(screen.getByRole('link', { name: 'youtu.be/abc123' })).toHaveAttribute(
      'href',
      'https://youtu.be/abc123',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Verified · private');
  });

  it('offers discard and retry on a failed step', async () => {
    const { ondiscard, onretry } = setup({
      view: view(
        'FAILED',
        {},
        { failedState: 'RENDER', error: 'The rendered Short never reached storage.' },
      ),
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onretry).toHaveBeenCalledOnce();
    expect(ondiscard).toHaveBeenCalledOnce();
  });

  it('disables discard and retry while busy', () => {
    setup({ view: view('FAILED'), busy: true });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  });

  it('shows no label without a pick', () => {
    setup({ view: view('HOOK', { hook: null }, {}, { pick: null }) });
    expect(screen.queryByLabelText('Title')).toBeNull();
  });
});

describe('Short: accessibility', () => {
  it('groups the framing radios under a legend and labels every control', () => {
    setup();
    const group = screen.getByRole('group', { name: 'Fit to 9:16' });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('spinbutton', { name: /^Start/ })).toBe(start());
    expect(screen.getByRole('spinbutton', { name: /^Length/ })).toBe(length());
    expect(screen.getByRole('region', { name: 'The Short' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Cut' })).toBeInTheDocument();
  });

  it('uses ids that cannot collide with the video tab', () => {
    const { container } = setup();
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.filter((id) => !id.startsWith('short-'))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

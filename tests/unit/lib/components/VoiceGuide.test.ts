import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuideState, Proposal, VoiceRules } from '#lib/brand.js';
import { POLL_BACKOFF } from '#lib/retry.js';
import VoiceGuide from '#lib/components/VoiceGuide.svelte';

const SOURCES = {
  uploads: [{ videoId: 'v1', title: 'My Song', publishedAt: '2026-10-01T00:00:00Z' }],
  drafts: [{ videoId: 'v2', title: 'Drafted Song', publishedAt: '2026-10-02T00:00:00Z' }],
  edits: 4,
  approvals: 2,
  thin: false,
};
const proposal = (over: Partial<Proposal<VoiceRules>> = {}): Proposal<VoiceRules> => ({
  id: 7,
  body: { rules: ['Short.', 'Dry humor.'] },
  sources: SOURCES,
  proposedAt: '2026-10-20T00:00:00.000Z',
  ...over,
});
const APPROVED = {
  body: { rules: ['Plain words.'] },
  sources: { uploads: 5, drafts: 1, edits: 3, approvals: 2, carriedOver: false },
  proposedAt: '2026-10-10T00:00:00.000Z',
  approvedAt: '2026-10-11T00:00:00.000Z',
};

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const setup = (guide: Partial<GuideState<VoiceRules>> = {}) =>
  render(VoiceGuide, {
    props: { guide: { approved: null, proposal: null, limitUntil: null, ...guide } },
  });
const rules = () => screen.getByLabelText(/^Rules/);
const form = () => screen.getByRole('form', { name: 'Proposed voice' });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('VoiceGuide: approved', () => {
  it('says drafts use plain rules before any voice is approved', () => {
    setup();
    expect(screen.getByText('Not set. Drafts use plain, generic rules.')).toBeInTheDocument();
  });

  it('lists the approved rules and where they came from', () => {
    setup({ approved: APPROVED });
    expect(screen.getByText('Plain words.')).toBeInTheDocument();
    expect(
      screen.getByText(
        /From 5 uploads,\s+1 Soundboard draft,\s+3 edits and 2 approvals,\s+proposed/,
      ),
    ).toBeInTheDocument();
  });

  it('marks a carried-over voice', () => {
    setup({ approved: { ...APPROVED, sources: { ...APPROVED.sources, carriedOver: true } } });
    expect(screen.getByText(/Carried over from your earlier rules/)).toBeInTheDocument();
  });
});

describe('VoiceGuide: proposal', () => {
  it('groups the sources, links each upload to its watch page, and fills one rule per line', () => {
    setup({ proposal: proposal() });
    const written = screen.getByRole('heading', { name: 'Written by you' }).parentElement!;
    expect(within(written).getByRole('link', { name: 'My Song' })).toHaveAttribute(
      'href',
      'https://www.youtube.com/watch?v=v1',
    );
    expect(within(written).getByRole('link', { name: 'My Song' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    const drafts = screen.getByRole('heading', {
      name: 'Approved Soundboard drafts',
    }).parentElement!;
    expect(within(drafts).getByRole('link', { name: 'Drafted Song' })).toHaveAttribute(
      'target',
      '_blank',
    );
    expect(screen.getByText(/4 edits and 2 approvals\s+in Soundboard/)).toBeInTheDocument();
    expect(rules()).toHaveValue('Short.\nDry humor.');
    expect(screen.queryByText(/Little writing/)).toBeNull();
  });

  it('says when the evidence is thin', () => {
    setup({ proposal: proposal({ sources: { ...SOURCES, thin: true } }) });
    expect(
      screen.getByText(/Little writing to learn from: 1 description,\s+4 edits\./),
    ).toBeInTheDocument();
  });

  it('hides an empty source group', () => {
    setup({ proposal: proposal({ sources: { ...SOURCES, drafts: [] } }) });
    expect(screen.queryByRole('heading', { name: 'Approved Soundboard drafts' })).toBeNull();
  });

  it('approves the edited rules, one per line, and shows them as the voice', async () => {
    fetchMock.mockResolvedValue(
      json({ approved: { ...APPROVED, body: { rules: ['Edited.', 'Second.'] } } }),
    );
    setup({ proposal: proposal() });
    await fireEvent.input(rules(), { target: { value: ' Edited. \n\n Second.' } });
    await fireEvent.click(within(form()).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText('Edited.')).toBeInTheDocument());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/guides/voice/approve');
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      rules: ['Edited.', 'Second.'],
      proposalId: 7,
    });
    expect(screen.queryByRole('form', { name: 'Proposed voice' })).toBeNull();
  });

  it('blocks approving no rules and says why', async () => {
    setup({ proposal: proposal() });
    await fireEvent.input(rules(), { target: { value: '   ' } });
    expect(within(form()).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByText('Add at least one voice rule.')).toBeInTheDocument();
  });

  it('keeps the edit and shows the message when another tab changed the guide', async () => {
    fetchMock.mockResolvedValue(
      json({ error: 'The guide changed in another tab. Reload to see it.' }, 404),
    );
    setup({ proposal: proposal() });
    await fireEvent.input(rules(), { target: { value: 'Mine.' } });
    await fireEvent.click(within(form()).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(
        screen.getByText('The guide changed in another tab. Reload to see it.'),
      ).toBeInTheDocument(),
    );
    expect(rules()).toHaveValue('Mine.');
  });

  it('discards the proposal and keeps the approved voice', async () => {
    fetchMock.mockResolvedValue(json({ proposal: null }));
    setup({ approved: APPROVED, proposal: proposal() });
    await fireEvent.click(within(form()).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Proposed voice' })).toBeNull());
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ proposalId: 7 });
    expect(screen.getByText('Plain words.')).toBeInTheDocument();
  });

  it('keeps the proposal and says so when a discard fails', async () => {
    fetchMock.mockResolvedValue(
      json({ error: 'The guide changed in another tab. Reload to see it.' }, 404),
    );
    setup({ proposal: proposal() });
    await fireEvent.click(within(form()).getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(
        screen.getByText('The guide changed in another tab. Reload to see it.'),
      ).toBeInTheDocument(),
    );
    expect(form()).toBeInTheDocument();
  });
});

describe('VoiceGuide: proposing', () => {
  it('shows the wait on the button, asks again, then opens the proposal', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json({ wait: 'model busy' }))
      .mockResolvedValueOnce(json({ proposal: proposal() }));
    setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model busy' })).toBeDisabled());
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF.minTimeout);
    await waitFor(() => expect(rules()).toHaveValue('Short.\nDry humor.'));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/guides/voice/propose',
      '/api/guides/voice/propose',
    ]);
  });

  it('holds proposing once the quota is spent', async () => {
    fetchMock.mockResolvedValue(json({ wait: 'model quota spent', limitUntil: Date.now() + 1000 }));
    setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Model quota spent' })).toBeDisabled(),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('shows the quota wait on load while the hold lasts', () => {
    setup({ limitUntil: Date.now() + 60_000 });
    expect(screen.getByRole('button', { name: 'Model quota spent' })).toBeDisabled();
  });

  it('ignores a hold that already ended', () => {
    setup({ limitUntil: Date.now() - 1 });
    expect(screen.getByRole('button', { name: 'Propose' })).toBeEnabled();
  });

  it('links to Connections when YouTube needs a reconnect', async () => {
    fetchMock.mockResolvedValue(json({ wait: 'reconnect YouTube' }));
    setup({ proposal: proposal() });
    await fireEvent.click(screen.getByRole('button', { name: 'Propose again' }));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Reconnect YouTube' })).toHaveAttribute(
        'href',
        '/connections',
      ),
    );
  });

  it('shows a refusal and does not ask again on its own', async () => {
    fetchMock.mockResolvedValue(
      json(
        { error: 'Nothing to learn from yet. Connect YouTube or finish a few releases first.' },
        409,
      ),
    );
    setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    await waitFor(() => expect(screen.getByText(/Nothing to learn from yet/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Propose' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('stops asking once the page is left mid-wait', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(json({ wait: 'model busy' }));
    const { unmount } = setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    await vi.advanceTimersByTimeAsync(0);
    unmount();
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF.minTimeout * 4);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('VoiceGuide: quota hold', () => {
  const RESET = 60_000;
  const propose = () => screen.getByRole('button', { name: 'Propose' });
  const spent = () => screen.getByRole('button', { name: 'Model quota spent' });

  beforeEach(() => vi.useFakeTimers());

  it('re-enables Propose once the quota reset passes after load', async () => {
    setup({ limitUntil: Date.now() + RESET });
    expect(spent()).toBeDisabled();
    await vi.advanceTimersByTimeAsync(RESET - 1);
    expect(spent()).toBeDisabled();
    await vi.advanceTimersByTimeAsync(1);
    expect(propose()).toBeEnabled();
  });

  it('re-enables Propose once the reset a proposal answered with passes', async () => {
    fetchMock.mockResolvedValue(
      json({ wait: 'model quota spent', limitUntil: Date.now() + RESET }),
    );
    setup();
    await fireEvent.click(propose());
    await vi.advanceTimersByTimeAsync(0);
    expect(spent()).toBeDisabled();
    await vi.advanceTimersByTimeAsync(RESET);
    expect(propose()).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not hold on a reset that already passed', async () => {
    fetchMock.mockResolvedValue(json({ wait: 'model quota spent', limitUntil: Date.now() - 1 }));
    setup({ limitUntil: null });
    await fireEvent.click(propose());
    await vi.advanceTimersByTimeAsync(0);
    expect(propose()).toBeEnabled();
  });

  it('keeps the reconnect hold however long it waits', async () => {
    fetchMock.mockResolvedValue(json({ wait: 'reconnect YouTube' }));
    setup();
    await fireEvent.click(propose());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(screen.getByRole('button', { name: 'Reconnect YouTube' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Reconnect YouTube' })).toBeInTheDocument();
  });
});

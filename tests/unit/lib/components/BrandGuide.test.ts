import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrandGuide as Guide, GuideState, Proposal } from '#lib/brand.js';
import { POLL_BACKOFF } from '#lib/retry.js';
import BrandGuide from '#lib/components/BrandGuide.svelte';

const GUIDE = {
  statement: 'Song title first, then a short story.',
  keep: ['Song title alone'],
  fix: ['One links block'],
  drop: ['All caps'],
};
const proposal = (): Proposal<Guide> => ({
  id: 3,
  body: GUIDE,
  sources: {
    uploads: [{ videoId: 'v1', title: 'My Song', publishedAt: '2026-10-01T00:00:00Z' }],
    drafts: [],
    edits: 0,
    approvals: 0,
    thin: false,
  },
  proposedAt: '2026-10-20T00:00:00.000Z',
});
const APPROVED = {
  body: GUIDE,
  sources: { uploads: 3, drafts: 0, edits: 0, approvals: 0, carriedOver: false },
  proposedAt: '2026-10-01T00:00:00.000Z',
  approvedAt: '2026-10-02T00:00:00.000Z',
};

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const setup = (guide: Partial<GuideState<Guide>> = {}) =>
  render(BrandGuide, {
    props: { guide: { approved: null, proposal: null, limitUntil: null, ...guide } },
  });
const form = () => screen.getByRole('form', { name: 'Proposed brand guide' });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BrandGuide: approved', () => {
  it('says drafts run without a guide until one is approved', () => {
    setup();
    expect(screen.getByText('Not set. Drafts run without one.')).toBeInTheDocument();
  });

  it('shows the approved statement, tagged rules and upload count', () => {
    setup({ approved: APPROVED });
    expect(screen.getByText(GUIDE.statement)).toBeInTheDocument();
    for (const rule of [...GUIDE.keep, ...GUIDE.fix, ...GUIDE.drop]) {
      expect(screen.getByText(rule)).toBeInTheDocument();
    }
    expect(screen.getByText(/From 3 uploads, proposed/)).toBeInTheDocument();
  });

  it('marks a carried-over guide', () => {
    setup({ approved: { ...APPROVED, sources: { ...APPROVED.sources, carriedOver: true } } });
    expect(screen.getByText(/Carried over from your earlier guide/)).toBeInTheDocument();
  });
});

describe('BrandGuide: proposal', () => {
  it('lists the uploads it read and fills the editor', () => {
    setup({ proposal: proposal() });
    expect(screen.getByRole('link', { name: 'My Song' })).toHaveAttribute(
      'href',
      'https://www.youtube.com/watch?v=v1',
    );
    expect(screen.getByLabelText(/^Statement/)).toHaveValue(GUIDE.statement);
    expect(screen.getByLabelText(/^Keep/)).toHaveValue('Song title alone');
  });

  it('approves the edited guide, trimmed, one rule per line', async () => {
    fetchMock.mockResolvedValue(
      json({ approved: { ...APPROVED, body: { ...GUIDE, statement: 'New.' } } }),
    );
    setup({ proposal: proposal() });
    await fireEvent.input(screen.getByLabelText(/^Statement/), { target: { value: '  New. ' } });
    await fireEvent.input(screen.getByLabelText(/^Fix/), { target: { value: 'A\n\n B ' } });
    await fireEvent.click(within(form()).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText('New.')).toBeInTheDocument());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/guides/brand/approve');
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      statement: 'New.',
      keep: ['Song title alone'],
      fix: ['A', 'B'],
      drop: ['All caps'],
      proposalId: 3,
    });
  });

  it('blocks an invalid edit and says why', async () => {
    setup({ proposal: proposal() });
    await fireEvent.input(screen.getByLabelText(/^Statement/), { target: { value: ' ' } });
    expect(within(form()).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByText('The brand statement is required.')).toBeInTheDocument();
  });

  it('keeps the edit and shows the message when approval fails', async () => {
    fetchMock.mockResolvedValue(
      json({ error: 'The guide changed in another tab. Reload to see it.' }, 404),
    );
    setup({ proposal: proposal() });
    await fireEvent.input(screen.getByLabelText(/^Statement/), { target: { value: 'Mine.' } });
    await fireEvent.click(within(form()).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText(/changed in another tab/)).toBeInTheDocument());
    expect(screen.getByLabelText(/^Statement/)).toHaveValue('Mine.');
  });

  it('discards the proposal', async () => {
    fetchMock.mockResolvedValue(json({ proposal: null }));
    setup({ proposal: proposal() });
    await fireEvent.click(within(form()).getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Proposed brand guide' })).toBeNull(),
    );
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/guides/brand/discard');
  });
});

describe('BrandGuide: proposing', () => {
  it('asks again after a wait, then opens the proposal', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json({ wait: 'waiting on YouTube' }))
      .mockResolvedValueOnce(json({ proposal: proposal() }));
    setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Waiting on YouTube' })).toBeDisabled(),
    );
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF.minTimeout);
    await waitFor(() => expect(screen.getByLabelText(/^Statement/)).toHaveValue(GUIDE.statement));
  });

  it('links to Connections once YouTube needs a reconnect', async () => {
    fetchMock.mockResolvedValue(json({ wait: 'reconnect YouTube' }));
    setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Reconnect YouTube' })).toHaveAttribute(
        'href',
        '/connections',
      ),
    );
    expect(screen.getByRole('button', { name: 'Reconnect YouTube' })).toBeDisabled();
  });

  it('shows a failed proposal and does not retry it on its own', async () => {
    fetchMock.mockResolvedValue(
      json({ error: 'The channel has no public uploads to learn from.' }, 409),
    );
    setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    await waitFor(() => expect(screen.getByText(/no public uploads/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

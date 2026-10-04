import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredBrand } from '$lib/brand';
import { WAIT_MS } from '$lib/driver';
import Page from '$routes/brand/+page.svelte';

const GUIDE = {
  statement: 'Song title first, then a short story.',
  keep: ['Song title alone'],
  fix: ['One links block'],
  drop: ['All caps'],
};
const stored = (status: StoredBrand['status']): StoredBrand => ({
  ...GUIDE,
  status,
  basedOn: ['v1', 'v2', 'v3'],
  createdAt: Date.UTC(2026, 9, 1),
  approvedAt: status === 'APPROVED' ? Date.UTC(2026, 9, 2) : null,
});

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const setup = (data: { approved?: StoredBrand | null; proposal?: StoredBrand | null } = {}) =>
  render(Page, {
    props: {
      data: { approved: null, proposal: null, session: null, channel: null, ...data },
    } as never,
  });

const urls = () => fetchMock.mock.calls.map((c) => c[0]);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('brand page: approved guide', () => {
  it('says smart pick follows the recent uploads until a guide is approved', () => {
    setup();
    expect(screen.getByText(/None yet/)).toBeInTheDocument();
  });

  it('shows the approved statement and rules', () => {
    setup({ approved: stored('APPROVED') });
    expect(screen.getByText(GUIDE.statement)).toBeInTheDocument();
    for (const rule of [...GUIDE.keep, ...GUIDE.fix, ...GUIDE.drop]) {
      expect(screen.getByText(rule)).toBeInTheDocument();
    }
    expect(screen.getByText(/From 3 uploads/)).toBeInTheDocument();
  });
});

describe('brand page: proposing', () => {
  it('asks again after a wait and then opens the proposal for editing', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json({ wait: 'waking model' }))
      .mockResolvedValueOnce(json({ proposal: stored('PROPOSED') }));
    setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'waking model' })).toBeDisabled(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WAIT_MS['waking model']);
    await waitFor(() => expect(screen.getByLabelText(/^Statement/)).toHaveValue(GUIDE.statement));
    expect(urls()).toEqual(['/api/brand/propose', '/api/brand/propose']);
  });

  it('shows a failed proposal and does not retry it on its own', async () => {
    fetchMock.mockResolvedValue(json({ error: 'The model reply did not parse.' }, 502));
    setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    await waitFor(() => expect(screen.getByText(/did not parse/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Propose' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('brand page: reviewing a proposal', () => {
  it('approves the edited guide, one rule per line', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const guide = JSON.parse(String(init!.body)) as typeof GUIDE;
      return json({ approved: { ...stored('APPROVED'), ...guide } });
    });
    setup({ proposal: stored('PROPOSED') });
    await fireEvent.input(screen.getByLabelText(/^Keep/), {
      target: { value: 'Song title alone\n\n  Lowercase hashtags  ' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText('Lowercase hashtags')).toBeInTheDocument());
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      ...GUIDE,
      keep: ['Song title alone', 'Lowercase hashtags'],
    });
    expect(screen.queryByLabelText(/^Statement/)).toBeNull();
  });

  it('blocks approval of an invalid edit and says why', async () => {
    setup({ proposal: stored('PROPOSED') });
    await fireEvent.input(screen.getByLabelText(/^Statement/), { target: { value: '  ' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByText('The brand statement is required.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server error when approval fails and keeps the edit', async () => {
    fetchMock.mockResolvedValue(json({ error: 'There is no proposal to approve.' }, 409));
    setup({ proposal: stored('PROPOSED') });
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText(/no proposal to approve/)).toBeInTheDocument());
    expect(screen.getByLabelText(/^Statement/)).toHaveValue(GUIDE.statement);
  });

  it('discards the proposal and keeps the approved guide', async () => {
    fetchMock.mockResolvedValue(json({ proposal: null }));
    setup({ approved: stored('APPROVED'), proposal: { ...stored('PROPOSED'), statement: 'New' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Propose' })).toBeEnabled());
    expect(urls()).toEqual(['/api/brand/discard']);
    expect(screen.getByText(GUIDE.statement)).toBeInTheDocument();
  });
});

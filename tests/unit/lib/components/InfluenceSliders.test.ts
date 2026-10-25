import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INFLUENCE, ROLES, type Influence } from '#lib/influence.js';
import InfluenceSliders from '#lib/components/InfluenceSliders.svelte';

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const onsaved = vi.fn();

const MINE: Influence = { sound: 0, feel: 2, wording: 3, discovery: 4, structure: 1 };
const renderSliders = (initial: Influence = DEFAULT_INFLUENCE, canSave = true) =>
  render(InfluenceSliders, { initial, canSave, onsaved });
const slider = (name: string) => screen.getByRole('slider', { name: new RegExp(`^${name}`) });
const save = () => screen.getByRole('button', { name: 'Save settings' });

beforeEach(() => {
  fetchMock.mockReset();
  onsaved.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('InfluenceSliders', () => {
  it('shows one 0–4 slider per role at the given levels, with the role’s default source', () => {
    renderSliders(MINE);
    expect(screen.getAllByRole('slider')).toHaveLength(ROLES.length);
    for (const [name, level] of [
      ['Sound', 0],
      ['Feel', 2],
      ['Wording', 3],
      ['Discovery', 4],
      ['Structure', 1],
    ] as const) {
      const input = slider(name);
      expect(input).toHaveValue(String(level));
      expect(input).toHaveAttribute('min', '0');
      expect(input).toHaveAttribute('max', '4');
      expect(input).toHaveAttribute('step', '1');
    }
    expect(slider('Feel')).toHaveAccessibleDescription(
      "The artist's own writing and approved edits",
    );
  });

  it('names both ends and says what the ends mean to a screen reader', () => {
    renderSliders({ ...DEFAULT_INFLUENCE, sound: 0, feel: 4, wording: 2 });
    expect(screen.getAllByText('Your own')).toHaveLength(ROLES.length);
    expect(screen.getAllByText('Strongest peer')).toHaveLength(ROLES.length);
    expect(slider('Sound')).toHaveAttribute('aria-valuetext', '0, your own');
    expect(slider('Feel')).toHaveAttribute('aria-valuetext', '4, strongest peer');
    expect(slider('Wording')).toHaveAttribute('aria-valuetext', '2');
  });

  it('saves every role as set and says so, handing the saved settings on', async () => {
    fetchMock.mockResolvedValue(json({ influence: { ...DEFAULT_INFLUENCE, wording: 3 } }));
    renderSliders();
    await fireEvent.input(slider('Wording'), { target: { value: '3' } });
    expect(screen.getByText('3', { selector: 'output' })).toBeInTheDocument();
    await fireEvent.click(save());
    expect(await screen.findByText('Saved. Applies to later drafts.')).toBeInTheDocument();
    const [path, init] = fetchMock.mock.calls[0]!;
    expect([path, init?.method]).toEqual(['/api/influence', 'PUT']);
    expect(JSON.parse(String(init?.body))).toEqual({ ...DEFAULT_INFLUENCE, wording: 3 });
    expect(onsaved).toHaveBeenCalledWith({ ...DEFAULT_INFLUENCE, wording: 3 });
  });

  it('shows the server’s message and keeps the choices when a save is refused', async () => {
    fetchMock.mockResolvedValue(
      json({ error: 'Each setting is a whole number from 0 to 4.' }, 422),
    );
    renderSliders();
    await fireEvent.input(slider('Sound'), { target: { value: '4' } });
    await fireEvent.click(save());
    expect(
      await screen.findByText('Each setting is a whole number from 0 to 4.'),
    ).toBeInTheDocument();
    expect(slider('Sound')).toHaveValue('4');
    expect(onsaved).not.toHaveBeenCalled();
  });

  it('says it could not save when the request fails outright', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    renderSliders();
    await fireEvent.click(save());
    expect(await screen.findByText("Couldn't save. Try again.")).toBeInTheDocument();
    expect(onsaved).not.toHaveBeenCalled();
  });

  it('disables Save and explains why, with a link to Brand, until a brand guide is approved', () => {
    renderSliders(DEFAULT_INFLUENCE, false);
    expect(save()).toBeDisabled();
    expect(
      screen.getByText(/Approve your brand guide to save your own settings\. Drafts use these/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Brand' })).toHaveAttribute('href', '/brand');
  });

  it('enables Save and shows no brand line once a brand guide is approved', () => {
    renderSliders();
    expect(save()).toBeEnabled();
    expect(screen.queryByRole('link', { name: 'Brand' })).toBeNull();
  });
});

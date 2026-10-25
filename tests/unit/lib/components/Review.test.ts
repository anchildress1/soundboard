import { fireEvent, render, screen } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Review from '$lib/components/Review.svelte';
import type { Pick } from '$lib/types';

const KEY = 'review:j1:1';
const APPROVE = 'Approve & upload';
const CHANNEL = { channelId: 'UCflr', channelTitle: 'Flies Like Robots' };

const PICK: Pick = {
  version: 1,
  title: 'PeekaBoo (Official Video)',
  description: 'Night drive.\n\n#synthwave',
  hashtags: ['#synthwave'],
  tags: ['synthwave', 'PeekaBoo'],
  flags: ['Silence 80.0s to 83.0s'],
  brandCheck: '',
  why: { title: 'Matches.', description: 'Plain.', tags: 'Genre first.' },
  bandcamp: { about: '', credits: '' },
  modelMs: 0,
};

function setup(props: Partial<ComponentProps<typeof Review>> = {}) {
  const onapprove = vi.fn();
  const onrerun = vi.fn();
  const ondiscard = vi.fn();
  const pick = props.pick ?? PICK;
  const utils = render(Review, {
    fields: {
      title: pick.title,
      description: pick.description,
      hashtags: pick.hashtags,
      tags: pick.tags,
    },
    pick,
    candidates: ['#synthwave', '#retrowave'],
    destination: CHANNEL,
    draft: KEY,
    onapprove,
    onrerun,
    ondiscard,
    ...props,
  });
  return { ...utils, onapprove, onrerun, ondiscard };
}

const heading = () => screen.getByRole('heading', { level: 1 });
const button = (name: string) => screen.getByRole('button', { name });
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const fact = (term: string) => screen.getByText(term, { selector: 'dt' }).nextElementSibling!;

async function walk(...names: string[]) {
  for (const name of names) await fireEvent.click(button(name));
}
const toApprove = () =>
  walk('Keep it, next', 'Looks right, next', 'Fine, next', 'Understood, next');

beforeEach(() => {
  localStorage.clear();
});

describe('Review: screens', () => {
  it('opens on the title with its count and why', () => {
    setup();
    expect(heading()).toHaveTextContent('Does this title work?');
    expect(field(/^Title/).value).toBe(PICK.title);
    expect(screen.getByText(`${PICK.title.length} / 100`)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Why this' })).toBeInTheDocument();
    expect(screen.getByText('Matches.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('leaves out an empty why', () => {
    setup({ pick: { ...PICK, why: { title: '', description: '', tags: '' } } });
    expect(screen.queryByRole('heading', { name: 'Why this' })).toBeNull();
  });

  it('walks every screen forward and back', async () => {
    setup();
    await walk('Keep it, next');
    expect(heading()).toHaveTextContent('Read the description');
    expect(field(/^Description/).value).toBe(PICK.description);
    expect(screen.getByText('Plain.')).toBeInTheDocument();
    await walk('Looks right, next');
    expect(heading()).toHaveTextContent('Check the tags');
    expect(field(/^Tags/).value).toBe('synthwave, PeekaBoo');
    expect(screen.getByText('18 / 500')).toBeInTheDocument();
    await walk('Fine, next');
    expect(heading()).toHaveTextContent('One thing to know before it uploads');
    expect(screen.getByRole('listitem')).toHaveTextContent('Silence 80.0s to 83.0s');
    await walk('Understood, next');
    expect(heading()).toHaveTextContent('Ready to upload');
    await walk('Back', 'Back', 'Back', 'Back');
    expect(heading()).toHaveTextContent('Does this title work?');
  });

  it('counts several flags in the check heading', async () => {
    setup({ pick: { ...PICK, flags: ['Silence 80.0s to 83.0s', 'Clipping at 12.0s'] } });
    await walk('Keep it, next', 'Looks right, next', 'Fine, next');
    expect(heading()).toHaveTextContent('2 things to know before it uploads');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('skips the check both ways when nothing was flagged', async () => {
    setup({ pick: { ...PICK, flags: [] } });
    await walk('Keep it, next', 'Looks right, next', 'Fine, next');
    expect(heading()).toHaveTextContent('Ready to upload');
    expect(screen.queryByText('Flags', { selector: 'dt' })).toBeNull();
    await walk('Back');
    expect(heading()).toHaveTextContent('Check the tags');
  });

  it('starts on the screen it is given', () => {
    setup({ step: 'tags' });
    expect(heading()).toHaveTextContent('Check the tags');
  });

  it('calls Re-run from each editing screen', async () => {
    const { onrerun } = setup();
    await fireEvent.click(button('Re-run model'));
    await walk('Keep it, next');
    await fireEvent.click(button('Re-run model'));
    await walk('Looks right, next');
    await fireEvent.click(button('Re-run model'));
    expect(onrerun).toHaveBeenCalledTimes(3);
  });
});

describe('Review: approval', () => {
  it('sums up what uploads and where', async () => {
    setup();
    await toApprove();
    expect(fact('Title')).toHaveTextContent(PICK.title);
    expect(fact('Description')).toHaveTextContent(
      `${PICK.description.length} characters · 1 hashtag`,
    );
    expect(fact('Tags')).toHaveTextContent('2 tags · 18 characters');
    expect(fact('Channel')).toHaveTextContent('Flies Like Robots');
    expect(fact('Channel')).toHaveTextContent('UCflr');
    expect(fact('Visibility')).toHaveTextContent('Private');
    expect(fact('Flags')).toHaveTextContent('1 noted');
  });

  it('pluralizes hashtags and names an untitled channel plainly', async () => {
    setup({
      pick: { ...PICK, description: 'Night drive. #synthwave #retrowave' },
      destination: { channelId: 'UCx', channelTitle: null },
    });
    await toApprove();
    expect(fact('Description')).toHaveTextContent('2 hashtags');
    expect(fact('Channel')).toHaveTextContent('your channel');
  });

  it('approves the edited fields with tags split, and clears the draft', async () => {
    const { onapprove } = setup();
    await fireEvent.input(field(/^Title/), { target: { value: 'Edited' } });
    await walk('Keep it, next', 'Looks right, next');
    await fireEvent.input(field(/^Tags/), { target: { value: ' synthwave , , night drive ' } });
    expect(localStorage.getItem(KEY)).not.toBeNull();
    await walk('Fine, next', 'Understood, next');
    await fireEvent.click(button(APPROVE));
    expect(onapprove).toHaveBeenCalledWith({
      title: 'Edited',
      description: PICK.description,
      tags: ['synthwave', 'night drive'],
    });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('discards from the approval screen', async () => {
    const { ondiscard, onapprove } = setup();
    await toApprove();
    await fireEvent.click(button('Discard release'));
    expect(ondiscard).toHaveBeenCalledTimes(1);
    expect(onapprove).not.toHaveBeenCalled();
  });

  it('sends YouTube reconnection instead of approval without a channel', async () => {
    const { ondiscard } = setup({ destination: null });
    await toApprove();
    expect(fact('Channel')).toHaveTextContent('Not connected');
    expect(screen.getByText('Reconnect YouTube to upload.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reconnect YouTube' })).toHaveAttribute(
      'href',
      '/connections',
    );
    expect(screen.queryByRole('button', { name: APPROVE })).toBeNull();
    await fireEvent.click(button('Discard release'));
    expect(ondiscard).toHaveBeenCalledTimes(1);
    await fireEvent.click(button('Back'));
    expect(
      screen.getByRole('heading', { name: 'One thing to know before it uploads' }),
    ).toBeInTheDocument();
  });

  it('disables every action while busy', async () => {
    setup({ busy: true });
    expect(button('Keep it, next')).toBeDisabled();
    expect(button('Re-run model')).toBeDisabled();
  });

  it('disables approval and discard while busy on the last screen', () => {
    setup({ busy: true, step: 'approve' });
    expect(button(APPROVE)).toBeDisabled();
    expect(button('Discard release')).toBeDisabled();
    expect(button('Back')).toBeEnabled();
  });
});

describe('Review: validation', () => {
  it('blocks the title screen on an empty title', async () => {
    setup();
    await fireEvent.input(field(/^Title/), { target: { value: '  ' } });
    expect(screen.getByText('Title is required.')).toBeInTheDocument();
    expect(button('Keep it, next')).toBeDisabled();
  });

  it('blocks the description on a hashtag outside the candidates', async () => {
    setup({ step: 'description' });
    await fireEvent.input(field(/^Description/), { target: { value: 'Night. #vaporwave' } });
    expect(screen.getByText("Not in this job's hashtag list: #vaporwave")).toBeInTheDocument();
    expect(button('Looks right, next')).toBeDisabled();
  });

  it('blocks the tags on a hashtag', async () => {
    setup({ step: 'tags' });
    await fireEvent.input(field(/^Tags/), { target: { value: '#synthwave' } });
    expect(
      screen.getByText('Tags are plain terms; hashtags belong in the description.'),
    ).toBeInTheDocument();
    expect(button('Fine, next')).toBeDisabled();
  });

  it('names the first bad field on the approval screen and goes back to fix it', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ title: '', description: 'd #nope', tags: 'synthwave', step: 'approve' }),
    );
    setup();
    expect(screen.getByRole('alert')).toHaveTextContent('Title is required.');
    expect(button(APPROVE)).toBeDisabled();
    await fireEvent.click(button('Fix the title'));
    expect(heading()).toHaveTextContent('Does this title work?');
  });

  it('lands on the field the server refused, even when it passes here', async () => {
    const { rerender } = setup({ step: 'approve' });
    await rerender({ serverErrors: { description: 'Rejected description.' } });
    expect(heading()).toHaveTextContent('Read the description');
    expect(screen.getByText('Rejected description.')).toBeInTheDocument();
  });

  it('shows a server error on the approval screen once walked back to', async () => {
    const { rerender } = setup({ step: 'approve' });
    await rerender({ serverErrors: { tags: 'Rejected tags.' } });
    expect(heading()).toHaveTextContent('Check the tags');
    await walk('Back', 'Looks right, next', 'Fine, next', 'Understood, next');
    expect(screen.getByRole('alert')).toHaveTextContent('Rejected tags.');
    await fireEvent.click(button('Fix the tags'));
    expect(heading()).toHaveTextContent('Check the tags');
  });
});

describe('Review: draft', () => {
  it('saves edits and the screen as they change', async () => {
    setup();
    await fireEvent.input(field(/^Title/), { target: { value: 'Draft edit' } });
    await walk('Keep it, next');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      title: 'Draft edit',
      description: PICK.description,
      tags: 'synthwave, PeekaBoo',
      step: 'description',
    });
  });

  it('restores a saved draft and its screen', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ title: 'Saved', description: 'Saved body', tags: 'a, b', step: 'tags' }),
    );
    setup();
    expect(heading()).toHaveTextContent('Check the tags');
    expect(field(/^Tags/).value).toBe('a, b');
  });

  it('keeps the edits but opens on the title when the saved screen is unknown', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ title: 'Saved', description: 'd', tags: 't', step: 'publish' }),
    );
    setup();
    expect(heading()).toHaveTextContent('Does this title work?');
    expect(field(/^Title/).value).toBe('Saved');
  });

  it("ignores another pick's draft", () => {
    localStorage.setItem(
      'review:j1:2',
      JSON.stringify({ title: 'Other', description: 'd', tags: 't', step: 'tags' }),
    );
    setup();
    expect(field(/^Title/).value).toBe(PICK.title);
  });
});

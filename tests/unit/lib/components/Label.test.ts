import { fireEvent, render, screen } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import Label from '$lib/components/Label.svelte';
import type { PickFields } from '$lib/types';

const fields: PickFields = {
  title: 'PeekaBoo',
  description: 'Night drive.\n\n#synthwave #retrowave',
  hashtags: ['#synthwave', '#retrowave'],
  tags: ['synthwave', 'PeekaBoo', 'Flies Like Robots'],
};

const candidates = ['#synthwave', '#retrowave', '#newmusic'];

function setup(props: Partial<ComponentProps<typeof Label>> = {}) {
  const onapprove = vi.fn();
  const onrerun = vi.fn();
  const ondiscard = vi.fn();
  const utils = render(Label, {
    fields,
    candidates,
    editable: true,
    onapprove,
    onrerun,
    ondiscard,
    ...props,
  });
  return { ...utils, onapprove, onrerun, ondiscard };
}

const title = () => screen.getByLabelText('Title') as HTMLInputElement;
const description = () => screen.getByLabelText(/^Description/) as HTMLTextAreaElement;
const tags = () => screen.getByLabelText(/^Tags/) as HTMLTextAreaElement;
const approveButton = () => screen.getByRole('button', { name: 'Approve & upload' });

describe('Label: draft and counters', () => {
  it('fills the fields from the draft with live counters', () => {
    setup();
    expect(title().value).toBe('PeekaBoo');
    expect(description().value).toBe(fields.description);
    expect(tags().value).toBe('synthwave, PeekaBoo, Flies Like Robots');
    expect(screen.getByText('8 / 100')).toBeInTheDocument();
    // "Flies Like Robots" has spaces, so YouTube counts its quotes: 9 + 8 + 19 + 2 commas.
    expect(screen.getByText('38 / 500')).toBeInTheDocument();
    expect(screen.getByText('Private')).toBeInTheDocument();
    expect(approveButton()).toBeEnabled();
  });

  it('updates the title counter as Nathan types', async () => {
    setup();
    await fireEvent.input(title(), { target: { value: 'PeekaBoo (Official Video)' } });
    expect(screen.getByText('25 / 100')).toBeInTheDocument();
  });

  it('updates the tag counter as tags change', async () => {
    setup();
    await fireEvent.input(tags(), { target: { value: 'a, b' } });
    expect(screen.getByText('3 / 500')).toBeInTheDocument();
    await fireEvent.input(tags(), { target: { value: '' } });
    expect(screen.getByText('0 / 500')).toBeInTheDocument();
  });
});

describe('Label: validation', () => {
  it('disables Approve past 500 tag characters', async () => {
    setup();
    const long = Array.from({ length: 60 }, (_, i) => `tag${String(i).padStart(4, '0')}`).join(
      ', ',
    );
    await fireEvent.input(tags(), { target: { value: long } });
    expect(screen.getByText('479 / 500')).toBeInTheDocument();
    expect(approveButton()).toBeEnabled();
    await fireEvent.input(tags(), { target: { value: `${long}, extra-tag-x, more-tags-y` } });
    expect(screen.getByText('503 / 500')).toBeInTheDocument();
    expect(screen.getByText('Tags are 503 / 500 characters.')).toBeInTheDocument();
    expect(approveButton()).toBeDisabled();
  });

  it('disables Approve when a stray hashtag is typed', async () => {
    setup();
    await fireEvent.input(description(), { target: { value: 'Night drive. #synthwave #madeup' } });
    expect(screen.getByText("Not in this job's hashtag list: #madeup")).toBeInTheDocument();
    expect(approveButton()).toBeDisabled();
    await fireEvent.input(description(), { target: { value: 'Night drive. #NewMusic' } });
    expect(approveButton()).toBeEnabled();
  });

  it('disables Approve for an empty title', async () => {
    setup();
    await fireEvent.input(title(), { target: { value: '   ' } });
    expect(screen.getByText('Title is required.')).toBeInTheDocument();
    expect(approveButton()).toBeDisabled();
  });

  it('shows server field errors and holds Approve', () => {
    setup({ serverErrors: { title: 'Rejected by YouTube.' } });
    expect(screen.getByText('Rejected by YouTube.')).toBeInTheDocument();
    expect(approveButton()).toBeDisabled();
  });

  it('shows the tags hint when tags are fine', () => {
    setup();
    expect(
      screen.getByText('Plain terms, comma-separated. Hashtags live in the description.'),
    ).toBeInTheDocument();
  });
});

describe('Label: actions', () => {
  it('approves the edited fields with split tags', async () => {
    const { onapprove } = setup();
    await fireEvent.input(title(), { target: { value: 'PeekaBoo (Official Video)' } });
    await fireEvent.input(tags(), { target: { value: ' synthwave , , PeekaBoo ' } });
    await fireEvent.click(approveButton());
    expect(onapprove).toHaveBeenCalledWith({
      title: 'PeekaBoo (Official Video)',
      description: fields.description,
      tags: ['synthwave', 'PeekaBoo'],
    });
  });

  it('fires re-run and discard', async () => {
    const { onrerun, ondiscard, onapprove } = setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Re-run model' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onrerun).toHaveBeenCalledTimes(1);
    expect(ondiscard).toHaveBeenCalledTimes(1);
    expect(onapprove).not.toHaveBeenCalled();
  });

  it('disables every action while busy', () => {
    setup({ busy: true });
    for (const name of ['Discard', 'Re-run model', 'Approve & upload']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });
});

describe('Label: read-only', () => {
  it('locks the fields and hides actions when not editable', () => {
    setup({ editable: false });
    expect(title()).toHaveAttribute('readonly');
    expect(description()).toHaveAttribute('readonly');
    expect(tags()).toHaveAttribute('readonly');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a disabled Uploaded button once the upload started', () => {
    setup({ editable: false, done: true });
    expect(screen.getByRole('button', { name: 'Uploaded' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Re-run model' })).toBeDisabled();
  });
});

describe('Label: a second label on the page', () => {
  it('prefixes field ids so labels stay tied to their own fields', () => {
    const { container } = setup({ idPrefix: 'short-' });
    expect(title().id).toBe('short-title');
    expect(description().id).toBe('short-desc');
    expect(tags().id).toBe('short-tags');
    expect(container.querySelector('#title')).toBeNull();
  });

  it('keeps the plain ids by default', () => {
    setup();
    expect(title().id).toBe('title');
  });

  it('takes its own region name and re-run label', async () => {
    const { onrerun } = setup({
      name: 'What goes to YouTube with the Short',
      rerunLabel: 'Re-pick hook',
    });
    expect(
      screen.getByRole('region', { name: 'What goes to YouTube with the Short' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-run model' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Re-pick hook' }));
    expect(onrerun).toHaveBeenCalledOnce();
  });
});

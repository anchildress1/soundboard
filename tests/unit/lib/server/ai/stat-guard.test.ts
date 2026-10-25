import { describe, expect, it } from 'vitest';
import { stripNumerics } from '#lib/server/ai/numerics.js';
import { NOT_STATED, stripStats } from '#lib/server/ai/stat-guard.js';

describe('stripStats', () => {
  it.each([
    '1200 views',
    'The net is 12 subscribers.',
    'Views rose 20%.',
    'It reached twelve thousand views.',
    'That release doubled its subscribers.',
    'It got 2x the plays.',
    'Got 1,200 views in a week.',
    'Engagement ran at 4.5 percent.',
    'About twenty per cent more.',
    'Subscribers grew by 40.',
    'A dozen subscribers joined.',
    'A few hundred plays came in.',
    'Peers get twice as many comments.',
    'It sits at 12k subscribers.',
    'Total reach was 3000.',
  ])('removes the statistic in "%s"', (sentence) => {
    expect(stripStats(sentence)).toEqual({ text: NOT_STATED, removed: true });
  });

  it.each([
    'Follow the last 3 releases.',
    'Open with a 60-second intro.',
    'Track 2 sets the mood.',
  ])('keeps "%s"', (sentence) => {
    expect(stripStats(sentence)).toEqual({ text: sentence, removed: false });
  });

  it('removes only the sentences with a statistic and keeps the rest', () => {
    expect(
      stripStats('Keep titles short. It got 1200 views! Name the album.\nViews rose 20%.'),
    ).toEqual({
      text: 'Keep titles short. Name the album.',
      removed: true,
    });
  });

  it('keeps line breaks between kept sentences', () => {
    expect(stripStats('First line.\n\nThe net is 12 subscribers.\nLast line.').text).toBe(
      'First line.\n\nLast line.',
    );
  });

  it('leaves empty text alone', () => {
    expect(stripStats('')).toEqual({ text: '', removed: false });
  });

  it("leaves numerics.ts's audio job unchanged", () => {
    expect(stripNumerics('Loud at -9 LUFS, with 1200 views.')).toBe('Loud at, with 1200 views.');
  });
});

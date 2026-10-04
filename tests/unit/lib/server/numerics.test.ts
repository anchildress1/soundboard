import { describe, expect, it } from 'vitest';
import { stripDeep, stripNumerics } from '$lib/server/numerics';

describe('stripNumerics', () => {
  it('leaves dates and URL paths alone when a sentence only says video clip', () => {
    const text = 'Official video clip. Out 10/31/2024 at https://flr.example/2024/tour';
    expect(stripNumerics(text)).toBe(text);
  });

  it('scopes clipping counts to their own sentence', () => {
    expect(stripNumerics('Clipping at 0 dBFS. Shot in 2024 over 3 days.')).toBe(
      'Clipping at. Shot in 2024 over 3 days.',
    );
  });

  it('drops counts and times from clipping and silence remarks', () => {
    expect(stripNumerics('12 clipped samples in the chorus')).toBe('clipped samples in the chorus');
    expect(stripNumerics('Silence from 4s to 7.5 s, dropout at 1:02')).toBe(
      'Silence from to, dropout at',
    );
  });

  it('keeps counts in remarks that are not about clipping or silence', () => {
    expect(stripNumerics('3 dancers at 1080p')).toBe('3 dancers at 1080p');
  });

  it('removes loudness, peak, tempo, and frequency figures', () => {
    expect(stripNumerics('Loud master at -9.7 LUFS with peaks near -0.4 dBTP.')).toBe(
      'Loud master at with peaks near.',
    );
    expect(stripNumerics('Driving 128 BPM groove')).toBe('Driving groove');
    expect(stripNumerics('Sub energy around 40Hz and air at 12 kHz')).toBe(
      'Sub energy around and air at',
    );
  });

  it('removes every unit variant, signs, and decimal commas', () => {
    for (const figure of [
      '-14 LUFS',
      '+3 dB',
      '−6 dBFS',
      '-1 dBTP',
      '85 dBA',
      '-23 LKFS',
      '7 LU',
      '120 bpm',
      '440 Hz',
      '2,5 kHz',
      '-14LUFS',
    ]) {
      expect(stripNumerics(`a ${figure} b`)).toBe('a b');
    }
  });

  it('drops parentheses left empty and tidies spacing before punctuation', () => {
    expect(stripNumerics('Punchy kick (-12 LUFS), wide pads (3 dB) ; bright')).toBe(
      'Punchy kick, wide pads; bright',
    );
  });

  it('leaves plain words and unrelated numbers alone', () => {
    expect(stripNumerics('Two verses, 3 choruses, and a lucky 7 lunch')).toBe(
      'Two verses, 3 choruses, and a lucky 7 lunch',
    );
    expect(stripNumerics('Shot in 1080p at 24 fps')).toBe('Shot in 1080p at 24 fps');
  });

  it('returns an empty string when the text is only a figure', () => {
    expect(stripNumerics('  -9.7 LUFS  ')).toBe('');
    expect(stripNumerics('')).toBe('');
  });

  it('keeps line breaks while collapsing runs of spaces', () => {
    expect(stripNumerics('line one at 3 dB  end\nline two')).toBe('line one at end\nline two');
  });
});

describe('stripDeep', () => {
  it('strips every string in nested objects and arrays', () => {
    const value = {
      visual: 'Neon city at -8 LUFS',
      music: { genre: ['synthwave', '120 BPM'], tempoFeel: 'mid-tempo, 118 bpm', mood: [] },
      qualityFlags: ['clipping at 0 dBFS'],
    };
    expect(stripDeep(value)).toEqual({
      visual: 'Neon city at',
      music: { genre: ['synthwave'], tempoFeel: 'mid-tempo,', mood: [] },
      qualityFlags: ['clipping at'],
    });
  });

  it('does not mutate the input', () => {
    const value = { a: ['3 dB louder'] };
    stripDeep(value);
    expect(value).toEqual({ a: ['3 dB louder'] });
  });

  it('passes through numbers, booleans, and null', () => {
    expect(stripDeep(42)).toBe(42);
    expect(stripDeep(true)).toBe(true);
    expect(stripDeep(null)).toBeNull();
    expect(stripDeep(undefined)).toBeUndefined();
    expect(stripDeep({ n: -14, ok: false, x: null })).toEqual({ n: -14, ok: false, x: null });
  });

  it('keeps non-string array items even when falsy', () => {
    expect(stripDeep([0, '', '6 dB', 'kept', null])).toEqual([0, 'kept', null]);
  });
});

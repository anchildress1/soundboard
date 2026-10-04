import { describe, expect, it } from 'vitest';
import {
  canCutShort,
  cutErrors,
  floorTenth,
  lengthBounds,
  SHORT_MAX_SEC,
  SHORT_MIN_SEC,
  tenth,
} from '$lib/short';

describe('tenth', () => {
  it('rounds to a tenth of a second', () => {
    expect(tenth(40.04)).toBe(40);
    expect(tenth(40.05)).toBeCloseTo(40.1, 9);
    expect(tenth(-0.04)).toBe(-0);
  });
});

describe('floorTenth', () => {
  it('rounds down to a tenth', () => {
    expect(floorTenth(30.06)).toBe(30);
    expect(floorTenth(30.09)).toBe(30);
    expect(floorTenth(30)).toBe(30);
  });

  it('keeps a tenth that floating point stores just under itself', () => {
    expect(floorTenth(2.3)).toBe(2.3);
    expect(floorTenth(180 - 147.5)).toBe(32.5);
    expect(floorTenth(0.3)).toBe(0.3);
  });
});

describe('lengthBounds', () => {
  it('is 15 to 60 seconds for a full-length video', () => {
    expect(lengthBounds(240)).toEqual({ min: SHORT_MIN_SEC, max: SHORT_MAX_SEC });
  });

  it('caps the length at the source for a 30-second sample', () => {
    expect(lengthBounds(30.04)).toEqual({ min: 15, max: 30 });
    // Rounding to nearest would allow 30.1 s, past the end of the source.
    expect(lengthBounds(30.06)).toEqual({ min: 15, max: 30 });
  });

  it('is exactly 60 at a 60-second source', () => {
    expect(lengthBounds(60)).toEqual({ min: 15, max: 60 });
  });
});

describe('canCutShort', () => {
  it('takes a source of 15 seconds or more', () => {
    expect(canCutShort(SHORT_MIN_SEC)).toBe(true);
    expect(canCutShort(240)).toBe(true);
  });

  it('refuses a source under 15 seconds, or of no length', () => {
    expect(canCutShort(14.9)).toBe(false);
    expect(canCutShort(0)).toBe(false);
    expect(canCutShort(Number.NaN)).toBe(false);
  });
});

describe('cutErrors', () => {
  it('accepts a cut inside the source', () => {
    expect(cutErrors({ startSec: 40, lengthSec: 30 }, 180)).toEqual({});
  });

  it('accepts a cut ending exactly at the end of the source', () => {
    expect(cutErrors({ startSec: 150, lengthSec: 30 }, 180)).toEqual({});
    expect(cutErrors({ startSec: 0, lengthSec: 15 }, 15)).toEqual({});
    expect(cutErrors({ startSec: 15, lengthSec: 15 }, 30.06)).toEqual({});
  });

  it('refuses a start that rounds the cut past the end of the source', () => {
    expect(cutErrors({ startSec: 15.1, lengthSec: 15 }, 30.06)).toEqual({
      startSec: 'Start must be 0 to 15 seconds for that length.',
    });
    expect(cutErrors({ startSec: 0, lengthSec: 30.1 }, 30.06)).toEqual({
      lengthSec: 'Length must be 15 to 30 seconds.',
    });
  });

  it('rejects a length outside the bounds', () => {
    expect(cutErrors({ startSec: 0, lengthSec: 14.9 }, 180).lengthSec).toBe(
      'Length must be 15 to 60 seconds.',
    );
    expect(cutErrors({ startSec: 0, lengthSec: 61 }, 180).lengthSec).toBeDefined();
    expect(cutErrors({ startSec: 0, lengthSec: 31 }, 30).lengthSec).toBe(
      'Length must be 15 to 30 seconds.',
    );
  });

  it('rejects a start that runs the cut past the end, or before zero', () => {
    expect(cutErrors({ startSec: 150.1, lengthSec: 30 }, 180).startSec).toBe(
      'Start must be 0 to 150 seconds for that length.',
    );
    expect(cutErrors({ startSec: -0.1, lengthSec: 30 }, 180).startSec).toBeDefined();
  });

  it('rejects non-numbers from empty inputs', () => {
    expect(cutErrors({ startSec: 0, lengthSec: Number.NaN }, 180).lengthSec).toBeDefined();
    expect(cutErrors({ startSec: Number.NaN, lengthSec: 20 }, 180).startSec).toBeDefined();
  });

  it('reports only the length when both are wrong, since the start bound depends on it', () => {
    expect(cutErrors({ startSec: -5, lengthSec: 5 }, 180)).toEqual({
      lengthSec: 'Length must be 15 to 60 seconds.',
    });
  });
});

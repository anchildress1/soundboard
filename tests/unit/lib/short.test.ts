import { describe, expect, it } from 'vitest';
import { cutErrors, lengthBounds, SHORT_MAX_SEC, SHORT_MIN_SEC, tenth } from '$lib/short';

describe('tenth', () => {
  it('rounds to a tenth of a second', () => {
    expect(tenth(40.04)).toBe(40);
    expect(tenth(40.05)).toBe(40.1);
    expect(tenth(-0.04)).toBe(-0);
  });
});

describe('lengthBounds', () => {
  it('is 15 to 60 seconds for a full-length video', () => {
    expect(lengthBounds(240)).toEqual({ min: SHORT_MIN_SEC, max: SHORT_MAX_SEC });
  });

  it('caps the length at the source for a 30-second sample', () => {
    expect(lengthBounds(30.04)).toEqual({ min: 15, max: 30 });
  });

  it('is the whole source when the source runs under 15 seconds', () => {
    expect(lengthBounds(9.96)).toEqual({ min: 10, max: 10 });
  });

  it('is exactly 60 at a 60-second source', () => {
    expect(lengthBounds(60)).toEqual({ min: 15, max: 60 });
  });
});

describe('cutErrors', () => {
  it('accepts a cut inside the source', () => {
    expect(cutErrors({ startSec: 40, lengthSec: 30 }, 180)).toEqual({});
  });

  it('accepts a cut ending exactly at the end of the source', () => {
    expect(cutErrors({ startSec: 150, lengthSec: 30 }, 180)).toEqual({});
    expect(cutErrors({ startSec: 0, lengthSec: 15 }, 15)).toEqual({});
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

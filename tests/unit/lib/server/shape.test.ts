import { describe, expect, it } from 'vitest';
import { isFiniteNumber, isString, isStrings, shape } from '$lib/server/shape';

describe('isString / isFiniteNumber / isStrings', () => {
  it('accepts the matching type', () => {
    expect(isString('')).toBe(true);
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-2.5)).toBe(true);
    expect(isStrings([])).toBe(true);
    expect(isStrings(['a', 'b'])).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isString(1)).toBe(false);
    expect(isString(null)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isStrings(['a', 1])).toBe(false);
    expect(isStrings('a')).toBe(false);
  });
});

describe('shape', () => {
  const pair = shape({ name: isString, tags: isStrings, inner: shape({ n: isFiniteNumber }) });

  it('accepts an object whose listed fields pass, ignoring extra fields', () => {
    expect(pair({ name: 'x', tags: [], inner: { n: 1 }, extra: true })).toBe(true);
  });

  it('rejects a missing or mistyped field, at any depth', () => {
    expect(pair({ tags: [], inner: { n: 1 } })).toBe(false);
    expect(pair({ name: 'x', tags: [1], inner: { n: 1 } })).toBe(false);
    expect(pair({ name: 'x', tags: [], inner: { n: 'one' } })).toBe(false);
    expect(pair({ name: 'x', tags: [], inner: null })).toBe(false);
  });

  it('rejects null, arrays, and primitives', () => {
    expect(pair(null)).toBe(false);
    expect(pair(undefined)).toBe(false);
    expect(pair([])).toBe(false);
    expect(pair('object')).toBe(false);
  });

  it('accepts any object when no fields are listed', () => {
    expect(shape({})({})).toBe(true);
    expect(shape({})([])).toBe(false);
  });
});

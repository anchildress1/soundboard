import { describe, expect, it } from 'vitest';
import { DEFAULT_INFLUENCE, INFLUENCE_ERROR, ROLES, influenceError } from '#lib/influence.js';

describe('influenceError', () => {
  it('accepts the defaults and every level', () => {
    expect(DEFAULT_INFLUENCE).toEqual({
      sound: 1,
      feel: 0,
      wording: 0,
      discovery: 4,
      structure: 4,
    });
    expect(influenceError(DEFAULT_INFLUENCE)).toBeNull();
    for (const level of [0, 1, 2, 3, 4]) {
      expect(influenceError(Object.fromEntries(ROLES.map((role) => [role, level])))).toBeNull();
    }
  });

  it.each([
    ['4 keys', { sound: 1, feel: 0, wording: 0, discovery: 4 }],
    ['6 keys', { ...DEFAULT_INFLUENCE, extra: 1 }],
    ['5', { ...DEFAULT_INFLUENCE, sound: 5 }],
    ['2.5', { ...DEFAULT_INFLUENCE, sound: 2.5 }],
    ['-1', { ...DEFAULT_INFLUENCE, sound: -1 }],
    ['"2"', { ...DEFAULT_INFLUENCE, sound: '2' }],
    ['an array', [1, 0, 0, 4, 4]],
    ['null', null],
    ['a number', 3],
    ['a renamed key', { feel: 0, wording: 0, discovery: 4, structure: 4, tone: 1 }],
  ])('refuses %s', (_name, value) => {
    expect(influenceError(value)).toBe(INFLUENCE_ERROR);
  });
});

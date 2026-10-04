import { describe, expect, it } from 'vitest';
import { guideError, RULE_MAX, RULES_MAX, splitRules, STATEMENT_MAX } from '$lib/brand';

const guide = { statement: 'Plain titles.', keep: ['Song only'], fix: [], drop: [] };

describe('splitRules', () => {
  it('takes one rule per line, trimmed, without blank lines', () => {
    expect(splitRules(' First \n\n  \nSecond')).toEqual(['First', 'Second']);
  });

  it('returns nothing for an empty field', () => {
    expect(splitRules('')).toEqual([]);
  });
});

describe('guideError', () => {
  it('passes a valid guide', () => {
    expect(guideError(guide)).toBeNull();
  });

  it('requires a statement', () => {
    expect(guideError({ ...guide, statement: '  ' })).toMatch(/required/);
  });

  it('accepts a statement exactly at the limit and rejects one over it', () => {
    expect(guideError({ ...guide, statement: 'a'.repeat(STATEMENT_MAX) })).toBeNull();
    expect(guideError({ ...guide, statement: 'a'.repeat(STATEMENT_MAX + 1) })).toMatch(/statement/);
  });

  it('caps the rules per list', () => {
    const rules = Array.from({ length: RULES_MAX + 1 }, (_, i) => `r${i}`);
    expect(guideError({ ...guide, fix: rules })).toMatch(/^Fix/);
  });

  it('caps each rule length', () => {
    expect(guideError({ ...guide, drop: ['x'.repeat(RULE_MAX + 1)] })).toMatch(/drop rule/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  counted,
  guideError,
  RULE_MAX,
  RULES_MAX,
  splitRules,
  STATEMENT_MAX,
  voiceError,
  VOICE_RULE_MAX,
  VOICE_RULES_MAX,
} from '#lib/brand.js';

const guide = { statement: 'Plain titles.', keep: ['Song only'], fix: [], drop: [] };

describe('counted', () => {
  it.each([
    [0, '0 edits'],
    [1, '1 edit'],
    [2, '2 edits'],
  ])('counts %i', (n, text) => {
    expect(counted(n, 'edit')).toBe(text);
  });
});

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

describe('voiceError', () => {
  const rules = (n: number) => Array.from({ length: n }, (_, i) => `Rule ${i + 1}`);

  it('requires at least one rule', () => {
    expect(voiceError({ rules: [] })).toBe('Add at least one voice rule.');
  });

  it('passes one rule and exactly the most rules', () => {
    expect(voiceError({ rules: rules(1) })).toBeNull();
    expect(voiceError({ rules: rules(VOICE_RULES_MAX) })).toBeNull();
  });

  it('refuses one rule past the cap', () => {
    expect(voiceError({ rules: rules(VOICE_RULES_MAX + 1) })).toBe('Voice has more than 12 rules.');
  });

  it('accepts a rule at the length limit and refuses one over it', () => {
    expect(voiceError({ rules: ['a'.repeat(VOICE_RULE_MAX)] })).toBeNull();
    expect(voiceError({ rules: ['a'.repeat(VOICE_RULE_MAX + 1)] })).toBe(
      'A voice rule is over 240 characters.',
    );
  });

  it('counts only the rules a textarea split keeps', () => {
    expect(voiceError({ rules: splitRules('  \n\n') })).toBe('Add at least one voice rule.');
    expect(voiceError({ rules: splitRules(' One \n  \nTwo') })).toBeNull();
  });
});

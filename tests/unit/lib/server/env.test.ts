import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowlist, modelUrl, optional, required } from '$lib/server/env';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('required', () => {
  it('returns the current value', () => {
    vi.stubEnv('SOUNDBOARD_TEST_VAR', 'one');
    expect(required('SOUNDBOARD_TEST_VAR')).toBe('one');
    vi.stubEnv('SOUNDBOARD_TEST_VAR', 'two');
    expect(required('SOUNDBOARD_TEST_VAR')).toBe('two');
  });

  it('throws when the variable is missing or empty', () => {
    vi.stubEnv('SOUNDBOARD_TEST_VAR', undefined);
    expect(() => required('SOUNDBOARD_TEST_VAR')).toThrow(
      'Missing required env var SOUNDBOARD_TEST_VAR',
    );
    vi.stubEnv('SOUNDBOARD_TEST_VAR', '');
    expect(() => required('SOUNDBOARD_TEST_VAR')).toThrow(/SOUNDBOARD_TEST_VAR/);
  });
});

describe('optional', () => {
  it('returns the value when set', () => {
    vi.stubEnv('SOUNDBOARD_TEST_VAR', 'set');
    expect(optional('SOUNDBOARD_TEST_VAR', 'fallback')).toBe('set');
  });

  it('falls back when missing or empty, defaulting to an empty string', () => {
    vi.stubEnv('SOUNDBOARD_TEST_VAR', '');
    expect(optional('SOUNDBOARD_TEST_VAR', 'fallback')).toBe('fallback');
    vi.stubEnv('SOUNDBOARD_TEST_VAR', undefined);
    expect(optional('SOUNDBOARD_TEST_VAR')).toBe('');
  });
});

describe('modelUrl', () => {
  it('defaults to a local llama-server', () => {
    vi.stubEnv('MODEL_URL', undefined);
    expect(modelUrl()).toBe('http://127.0.0.1:8081');
  });

  it('honours MODEL_URL', () => {
    vi.stubEnv('MODEL_URL', 'http://model.test:9000');
    expect(modelUrl()).toBe('http://model.test:9000');
  });
});

describe('allowlist', () => {
  it('parses a comma list, trimming and lowercasing', () => {
    vi.stubEnv('ALLOWLIST_EMAILS', ' Nathan@Example.com , ops@example.com,');
    expect(allowlist()).toEqual(new Set(['nathan@example.com', 'ops@example.com']));
  });

  it('is empty when unset or blank', () => {
    vi.stubEnv('ALLOWLIST_EMAILS', undefined);
    expect(allowlist().size).toBe(0);
    vi.stubEnv('ALLOWLIST_EMAILS', ' , ,');
    expect(allowlist().size).toBe(0);
  });

  it('collapses duplicates that differ only by case', () => {
    vi.stubEnv('ALLOWLIST_EMAILS', 'a@x.com,A@X.COM');
    expect([...allowlist()]).toEqual(['a@x.com']);
  });
});

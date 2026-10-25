import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analystModel,
  geminiApiKey,
  kmsKey,
  optional,
  pickModel,
  required,
  signupMode,
} from '#lib/server/core/env.js';

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

describe('geminiApiKey', () => {
  it('returns GEMINI_API_KEY', () => {
    vi.stubEnv('GEMINI_API_KEY', 'key-1');
    expect(geminiApiKey()).toBe('key-1');
  });
});

describe('model names', () => {
  it('default when unset or empty, as .env.example leaves them', () => {
    vi.stubEnv('GEMINI_ANALYST_MODEL', undefined);
    vi.stubEnv('GEMINI_PICK_MODEL', '');
    expect(analystModel()).toBe('gemini-3.8-flash');
    expect(pickModel()).toBe('gemini-4-argon');
  });

  it('honour overrides', () => {
    vi.stubEnv('GEMINI_ANALYST_MODEL', 'gemini-3.5-flash-lite');
    vi.stubEnv('GEMINI_PICK_MODEL', 'gemini-3.8-flash');
    expect(analystModel()).toBe('gemini-3.5-flash-lite');
    expect(pickModel()).toBe('gemini-3.8-flash');
  });
});

describe('signupMode', () => {
  it('defaults to invite when unset or empty', () => {
    vi.stubEnv('SIGNUP_MODE', undefined);
    expect(signupMode()).toBe('invite');
    vi.stubEnv('SIGNUP_MODE', '');
    expect(signupMode()).toBe('invite');
  });

  it('honours open and invite', () => {
    vi.stubEnv('SIGNUP_MODE', 'open');
    expect(signupMode()).toBe('open');
    vi.stubEnv('SIGNUP_MODE', 'invite');
    expect(signupMode()).toBe('invite');
  });

  it('rejects any other value instead of guessing', () => {
    vi.stubEnv('SIGNUP_MODE', 'Open');
    expect(() => signupMode()).toThrow('Unknown SIGNUP_MODE Open');
  });
});

describe('kmsKey', () => {
  it('returns KMS_KEY', () => {
    vi.stubEnv(
      'KMS_KEY',
      'projects/p/locations/us-central1/keyRings/soundboard/cryptoKeys/refresh-tokens',
    );
    expect(kmsKey()).toMatch(/cryptoKeys\/refresh-tokens$/);
  });
});

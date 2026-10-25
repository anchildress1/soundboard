import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analystModel,
  geminiApiKey,
  kmsKey,
  optional,
  peerHearing,
  pickModel,
  required,
  researchQueue,
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

describe('researchQueue', () => {
  const QUEUE = 'projects/p/locations/us-central1/queues/soundboard-research';
  const URL = 'https://soundboard-1.us-central1.run.app/api/research/task';
  const SA = 'runtime@p.iam.gserviceaccount.com';

  it('is null when none of the three is set', () => {
    for (const name of ['RESEARCH_QUEUE', 'RESEARCH_TASK_URL', 'RESEARCH_TASK_SA']) {
      vi.stubEnv(name, undefined);
    }
    expect(researchQueue()).toBeNull();
  });

  it('returns all three together', () => {
    vi.stubEnv('RESEARCH_QUEUE', QUEUE);
    vi.stubEnv('RESEARCH_TASK_URL', URL);
    vi.stubEnv('RESEARCH_TASK_SA', SA);
    expect(researchQueue()).toEqual({ queue: QUEUE, url: URL, serviceAccount: SA });
  });

  it.each([
    ['the queue alone', { RESEARCH_QUEUE: QUEUE }],
    ['no service account', { RESEARCH_QUEUE: QUEUE, RESEARCH_TASK_URL: URL }],
    ['no queue', { RESEARCH_TASK_URL: URL, RESEARCH_TASK_SA: SA }],
  ])('throws on a partial config: %s', (_name, set: Record<string, string>) => {
    for (const name of ['RESEARCH_QUEUE', 'RESEARCH_TASK_URL', 'RESEARCH_TASK_SA']) {
      vi.stubEnv(name, set[name] ?? '');
    }
    expect(() => researchQueue()).toThrow(
      'Set RESEARCH_QUEUE, RESEARCH_TASK_URL and RESEARCH_TASK_SA together',
    );
  });
});

describe('peerHearing', () => {
  it('is on only for 1', () => {
    vi.stubEnv('PEER_HEARING', '1');
    expect(peerHearing()).toBe(true);
    vi.stubEnv('PEER_HEARING', '');
    expect(peerHearing()).toBe(false);
    vi.stubEnv('PEER_HEARING', undefined);
    expect(peerHearing()).toBe(false);
  });

  it.each(['true', '0', 'yes'])('throws on %s', (value) => {
    vi.stubEnv('PEER_HEARING', value);
    expect(() => peerHearing()).toThrow(`PEER_HEARING must be 1 or unset, not ${value}`);
  });
});

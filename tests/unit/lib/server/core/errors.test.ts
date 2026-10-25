// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { invalidGrant, undecryptable } from '#lib/server/core/errors.js';

describe('invalidGrant', () => {
  const tokenError = (error: string) =>
    Object.assign(new Error('Bad Request'), { response: { data: { error } } });

  it("recognizes Google's invalid_grant body, whatever the message says", () => {
    expect(invalidGrant(tokenError('invalid_grant'))).toBe(true);
  });

  it.each([
    ['another token error', tokenError('invalid_client')],
    ['an error without a response', new Error('invalid_grant')],
    ['null', null],
    ['a string', 'invalid_grant'],
  ])('rejects %s', (_label, error) => {
    expect(invalidGrant(error)).toBe(false);
  });
});

describe('undecryptable', () => {
  // The shape @google-cloud/kms rejects with (gax GoogleError: numeric gRPC code plus details).
  const kmsError = (code: number, details: string) =>
    Object.assign(new Error(`${code} ${details}`), { code, details });

  it.each([
    [
      'sealed under another key',
      "Decryption failed: verify that 'name' refers to the correct CryptoKey.",
    ],
    ['corrupt bytes', 'Decryption failed: the ciphertext is invalid.'],
  ])('recognizes ciphertext KMS refuses: %s', (_label, details) => {
    expect(undecryptable(kmsError(3, details))).toBe(true);
  });

  it.each([
    ['a malformed key name', kmsError(3, 'Resource name [x] does not match any known pattern.')],
    ['a permission denial', kmsError(7, 'Decryption failed: denied')],
    ['an unavailable KMS', kmsError(14, 'Connection dropped')],
    ['a plain error', new Error('Decryption failed')],
    ['a non-string details', Object.assign(new Error('x'), { code: 3, details: 42 })],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, error) => {
    expect(undecryptable(error)).toBe(false);
  });
});

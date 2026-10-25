// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { invalidGrant } from '#lib/server/core/errors.js';

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

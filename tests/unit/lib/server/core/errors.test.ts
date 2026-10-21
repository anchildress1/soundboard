// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ActionError, invalidGrant } from '$lib/server/core/errors';

describe('ActionError', () => {
  it('carries status, message, and field errors', () => {
    const error = new ActionError(422, 'bad', { title: 'x' });
    expect(error).toBeInstanceOf(Error);
    expect([error.status, error.message, error.fields]).toEqual([422, 'bad', { title: 'x' }]);
    expect(new ActionError(400, 'm').fields).toBeUndefined();
  });
});

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

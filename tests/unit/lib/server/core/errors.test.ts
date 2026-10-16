// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ActionError } from '$lib/server/core/errors';

describe('ActionError', () => {
  it('carries status, message, and field errors', () => {
    const error = new ActionError(422, 'bad', { title: 'x' });
    expect(error).toBeInstanceOf(Error);
    expect([error.status, error.message, error.fields]).toEqual([422, 'bad', { title: 'x' }]);
    expect(new ActionError(400, 'm').fields).toBeUndefined();
  });
});

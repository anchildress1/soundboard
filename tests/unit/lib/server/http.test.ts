// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ActionError } from '$lib/server/actions';
import { num, readBody, respond, text } from '$lib/server/http';

const post = (body: string) =>
  new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

describe('respond', () => {
  it('serializes the route result as JSON', async () => {
    const response = await respond(async () => ({ ok: 1 }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ ok: 1 });
  });

  it('turns an ActionError into its status with field errors', async () => {
    const response = await respond(async () => {
      throw new ActionError(422, 'Fix the highlighted fields.', { title: 'Title is required.' });
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: 'Fix the highlighted fields.',
      fields: { title: 'Title is required.' },
    });
  });

  it('sends null fields when an ActionError has none', async () => {
    const response = await respond(async () => {
      throw new ActionError(409, 'Not now.');
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Not now.', fields: null });
  });

  it('rethrows anything else for SvelteKit to handle', async () => {
    const boom = new Error('boom');
    await expect(
      respond(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe('readBody', () => {
  it('returns a JSON object body', async () => {
    await expect(readBody(post('{"title":"PeekaBoo"}'))).resolves.toEqual({ title: 'PeekaBoo' });
  });

  it.each([
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['a string', '"hi"'],
    ['malformed JSON', '{nope'],
    ['an empty body', ''],
  ])('rejects %s with a 400 ActionError', async (_label, body) => {
    const error = await readBody(post(body)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect(error).toMatchObject({ status: 400, message: 'Expected a JSON object.' });
  });
});

describe('text', () => {
  it('passes a string through untouched', () => {
    expect(text('  PeekaBoo ')).toBe('  PeekaBoo ');
    expect(text('')).toBe('');
  });

  it('writes a number in decimal', () => {
    expect(text(42)).toBe('42');
    expect(text(-0.5)).toBe('-0.5');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a boolean', true],
    ['an object', { title: 'x' }],
    ['an array', ['x']],
  ])('reads %s as the fallback', (_label, value) => {
    expect(text(value)).toBe('');
    expect(text(value, 'video')).toBe('video');
  });
});

describe('num', () => {
  it('passes a JSON number through', () => {
    expect(num(70)).toBe(70);
    expect(num(-0.5)).toBe(-0.5);
    expect(num(0)).toBe(0);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['false', false],
    ['an empty array', []],
    ['a one-number array', [70]],
    ['a numeric string', '70'],
    ['an object', { n: 70 }],
  ])('reads %s as NaN', (_label, value) => {
    expect(num(value)).toBeNaN();
  });
});

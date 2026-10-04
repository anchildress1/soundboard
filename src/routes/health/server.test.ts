import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { GET } from './+server';

describe('GET /health', () => {
  it('returns 200 with ok: true', async () => {
    const response = await GET({} as RequestEvent<Record<string, never>, '/health'>);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

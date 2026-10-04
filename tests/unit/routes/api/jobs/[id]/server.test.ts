// @vitest-environment node
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { GET } from '$routes/api/jobs/[id]/+server';
import type { JobView } from '$lib/types';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

type Event = Parameters<typeof GET>[0];

const get = async (id: string, allowlisted: boolean | null) =>
  GET({
    params: { id },
    locals: {
      session: allowlisted === null ? null : { email: 'someone@example.com', allowlisted },
    },
  } as unknown as Event);

function seed(id: string, owner: 'visitor' | 'nathan') {
  store.set(`jobs/${id}`, {
    id,
    owner,
    state: 'ANALYZE',
    songTitle: 'PeekaBoo',
    chunkCount: 3,
    chunkIndex: 1,
    trace: { sentryTrace: 't', baggage: 'b' },
    ipHash: 'h',
    claim: null,
    upload: { sessionUri: 'https://upload.example/secret', total: 1 },
  });
}

async function thrown(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    return isHttpError(error) ? error.status : error;
  }
}

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
});

describe('GET /api/jobs/[id]', () => {
  it('returns the public view of a visitor job to a signed-out caller', async () => {
    seed('v', 'visitor');
    store.set('jobs/v/chunks/0000', { index: 0 });
    const response = await get('v', null);
    expect(response.status).toBe(200);
    const view = (await response.json()) as JobView;
    expect(view.job).toMatchObject({ id: 'v', state: 'ANALYZE', chunkIndex: 1 });
    expect(view.chunks).toHaveLength(1);
    expect(view.pick).toBeNull();
    expect(JSON.stringify(view)).not.toContain('upload.example/secret');
  });

  it("returns Nathan's job to an allowlisted session", async () => {
    seed('n', 'nathan');
    expect((await get('n', true)).status).toBe(200);
  });

  it("404s Nathan's job for a non-allowlisted session", async () => {
    seed('n', 'nathan');
    expect(await thrown(get('n', false))).toBe(404);
    expect(await thrown(get('n', null))).toBe(404);
  });

  it('404s an unknown job', async () => {
    expect(await thrown(get('ghost', true))).toBe(404);
  });
});

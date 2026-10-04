// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { load } from '$routes/+page.server';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../helpers/fake-firestore')).fakeFirestoreModule(),
);

type Event = Parameters<typeof load>[0];
const run = async () => (await load({} as Event)) as { samples: unknown[] };

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
});

describe('home load', () => {
  it('lists samples by song title without their bucket paths', async () => {
    store.set('samples/b', {
      songTitle: 'Zero',
      videoId: 'v2',
      object: 'samples/z.mp4',
      durationSec: 30,
    });
    store.set('samples/a', {
      songTitle: 'Neon',
      videoId: 'v1',
      object: 'samples/n.mp4',
      durationSec: 30,
    });
    const { samples } = await run();
    expect(samples).toEqual([
      { id: 'a', songTitle: 'Neon', videoId: 'v1', durationSec: 30 },
      { id: 'b', songTitle: 'Zero', videoId: 'v2', durationSec: 30 },
    ]);
    expect(JSON.stringify(samples)).not.toContain('samples/');
  });

  it('returns no samples when none are seeded', async () => {
    expect((await run()).samples).toEqual([]);
  });

  it('still renders the upload path when Firestore is unavailable', async () => {
    vi.stubEnv('GCP_PROJECT_ID', '');
    expect((await run()).samples).toEqual([]);
  });
});

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../helpers/fake-firestore';
import { resetClients } from '$lib/server/clients';
import { getSample, listSamples } from '$lib/server/samples';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

const sample = (songTitle: string) => ({
  songTitle,
  videoId: `yt-${songTitle}`,
  object: `samples/${songTitle}.mp4`,
  durationSec: 30,
});

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  resetStore();
  resetClients();
});

describe('listSamples', () => {
  it('returns samples sorted by song title with their doc ids', async () => {
    store.set('samples/b', sample('Zeta'));
    store.set('samples/a', sample('Alpha'));
    store.set('samples/c', sample('PeekaBoo'));
    const samples = await listSamples();
    expect(samples.map((s) => [s.id, s.songTitle])).toEqual([
      ['a', 'Alpha'],
      ['c', 'PeekaBoo'],
      ['b', 'Zeta'],
    ]);
    expect(samples[0]).toEqual({ id: 'a', ...sample('Alpha') });
  });

  it('returns an empty list when there are none', async () => {
    expect(await listSamples()).toEqual([]);
  });

  it('ignores nested documents', async () => {
    store.set('samples/a', sample('Alpha'));
    store.set('samples/a/extra/x', { songTitle: 'Nested' });
    expect((await listSamples()).map((s) => s.id)).toEqual(['a']);
  });

  it('lets the doc id win over a stored id field', async () => {
    store.set('samples/real', { ...sample('Alpha'), id: 'fake' });
    expect((await listSamples())[0]!.id).toBe('real');
  });
});

describe('getSample', () => {
  it('returns one sample with its id', async () => {
    store.set('samples/s1', sample('PeekaBoo'));
    expect(await getSample('s1')).toEqual({ id: 's1', ...sample('PeekaBoo') });
  });

  it('returns null for a missing sample', async () => {
    expect(await getSample('nope')).toBeNull();
  });

  it('throws without a project id', async () => {
    vi.stubEnv('GCP_PROJECT_ID', '');
    await expect(getSample('s1')).rejects.toThrow('GCP_PROJECT_ID');
  });
});

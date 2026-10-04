// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, store } from '../../../helpers/fake-firestore';
import { ActionError } from '$lib/server/actions';
import { resetClients } from '$lib/server/clients';
import { create, MAX_BYTES, NOTES_MAX, type CreateInput } from '$lib/server/create';
import { RUNS_PER_DAY } from '$lib/server/quota';
import type { JobDoc } from '$lib/server/jobs';

vi.mock('@google-cloud/firestore', async () =>
  (await import('../../../helpers/fake-firestore')).fakeFirestoreModule(),
);

const gcs = vi.hoisted(() => ({ getSignedUrl: vi.fn(), files: [] as string[] }));

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return {
        file(object: string) {
          gcs.files.push(object);
          return { getSignedUrl: gcs.getSignedUrl };
        },
      };
    }
  },
}));

const visitor = { allowlisted: false, ip: '203.0.113.7' };
const nathan = { allowlisted: true, ip: '198.51.100.1' };

const upload = (over: Record<string, unknown> = {}): CreateInput =>
  ({
    songTitle: 'PeekaBoo',
    notes: 'first cut',
    filename: 'peekaboo.mp4',
    contentType: 'video/mp4',
    size: 50_000_000,
    durationSec: 180,
    ...over,
  }) as CreateInput;

const job = (id: string) => store.get(`jobs/${id}`) as JobDoc;
const quota = () =>
  [...store.entries()].find(([k]) => k.startsWith('quota/'))?.[1] as
    { runs: number; ips: Record<string, number> } | undefined;

const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ActionError);
  return error as ActionError;
};

beforeEach(() => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'b');
  vi.stubEnv('SESSION_SECRET', 's');
  resetStore();
  resetClients();
  vi.clearAllMocks();
  gcs.files.length = 0;
  gcs.getSignedUrl.mockResolvedValue(['https://storage/put']);
  store.set('samples/peek', {
    songTitle: 'PeekaBoo',
    videoId: 'yt-peek',
    object: 'samples/peek.mp4',
    durationSec: 30,
  });
});

describe('create from a sample', () => {
  it('makes a visitor job on the sandbox channel with no upload URL', async () => {
    const { id, uploadUrl } = await create({ sampleId: 'peek' }, visitor);
    expect(uploadUrl).toBeNull();
    expect(gcs.getSignedUrl).not.toHaveBeenCalled();
    expect(job(id)).toMatchObject({
      owner: 'visitor',
      channel: 'sandbox',
      state: 'PREP',
      songTitle: 'PeekaBoo',
      notes: '',
      filename: 'PeekaBoo.mp4',
      contentType: 'video/mp4',
      object: 'samples/peek.mp4',
      sampleId: 'peek',
      liveVideoId: 'yt-peek',
    });
    expect(job(id).ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(job(id).ipHash).not.toContain('203.0.113.7');
    expect(quota()).toMatchObject({ runs: 1 });
  });

  it("makes an allowlisted sample job Nathan's, without IP caps", async () => {
    const { id } = await create({ sampleId: 'peek' }, nathan);
    expect(job(id)).toMatchObject({ owner: 'nathan', channel: 'nathan', ipHash: null });
    expect(quota()).toBeUndefined();
  });

  it('returns 404 for a missing sample', async () => {
    const error = await rejection(create({ sampleId: 'gone' }, visitor));
    expect(error.status).toBe(404);
    expect(quota()).toBeUndefined();
  });
});

describe('create from an own video', () => {
  it('makes a visitor job that ends at the payload, with a signed upload URL', async () => {
    const { id, uploadUrl } = await create(upload(), visitor);
    expect(uploadUrl).toBe('https://storage/put');
    expect(gcs.files).toEqual([`uploads/${id}`]);
    expect(gcs.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'write', contentType: 'video/mp4' }),
    );
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(job(id)).toMatchObject({
      owner: 'visitor',
      channel: null,
      state: 'AWAITING_UPLOAD',
      object: `uploads/${id}`,
      songTitle: 'PeekaBoo',
      notes: 'first cut',
      filename: 'peekaboo.mp4',
      sampleId: null,
      liveVideoId: null,
    });
  });

  it('trims the title and notes and caps the filename', async () => {
    const { id } = await create(
      upload({ songTitle: '  PeekaBoo  ', notes: '  n  ', filename: 'f'.repeat(300) }),
      visitor,
    );
    expect(job(id).songTitle).toBe('PeekaBoo');
    expect(job(id).notes).toBe('n');
    expect(job(id).filename).toHaveLength(200);
  });

  it('defaults a missing filename and notes', async () => {
    const { id } = await create(upload({ filename: undefined, notes: undefined }), visitor);
    expect(job(id).filename).toBe('video');
    expect(job(id).notes).toBe('');
  });

  it('accepts a visitor video at exactly 5 minutes and rejects one over', async () => {
    await expect(create(upload({ durationSec: 300 }), visitor)).resolves.toBeTruthy();
    const error = await rejection(create(upload({ durationSec: 301 }), visitor));
    expect(error.status).toBe(400);
    expect(error.message).toBe('Videos are capped at 5 minutes here.');
  });

  it("gives Nathan's uploads 15 minutes, his channel, and no IP caps", async () => {
    for (let i = 0; i < 6; i++) {
      const { id, uploadUrl } = await create(upload({ durationSec: 900 }), nathan);
      expect(uploadUrl).toBe('https://storage/put');
      expect(job(id)).toMatchObject({ owner: 'nathan', channel: 'nathan', ipHash: null });
    }
    expect(quota()).toBeUndefined();
    const error = await rejection(create(upload({ durationSec: 901 }), nathan));
    expect(error.message).toBe('Videos are capped at 15 minutes here.');
  });

  it.each([
    ['a missing title', { songTitle: '' }, 'Song title is required.'],
    ['a blank title', { songTitle: '   ' }, 'Song title is required.'],
    ['an undefined title', { songTitle: undefined }, 'Song title is required.'],
    [
      'a title over 100 chars',
      { songTitle: 'x'.repeat(101) },
      'Song title is over 100 characters.',
    ],
    [
      'notes over 1000 chars',
      { notes: 'n'.repeat(NOTES_MAX + 1) },
      'Notes are over 1000 characters.',
    ],
    ['a non-video type', { contentType: 'audio/mpeg' }, 'Pick a video file.'],
    ['a missing type', { contentType: undefined }, 'Pick a video file.'],
    ['size 0', { size: 0 }, 'Videos must be under 2 GB.'],
    ['size over 2 GB', { size: MAX_BYTES + 1 }, 'Videos must be under 2 GB.'],
    ['a non-numeric size', { size: 'big' }, 'Videos must be under 2 GB.'],
    ['duration 0', { durationSec: 0 }, 'Videos are capped at 5 minutes here.'],
    ['a NaN duration', { durationSec: 'long' }, 'Videos are capped at 5 minutes here.'],
  ])('rejects %s with 400', async (_label, over, message) => {
    const error = await rejection(create(upload(over), visitor));
    expect(error.status).toBe(400);
    expect(error.message).toBe(message);
    expect(store.size).toBe(1);
  });

  it('accepts the boundaries: 100-char title, 1000-char notes, exactly 2 GB', async () => {
    await expect(
      create(
        upload({ songTitle: 'x'.repeat(100), notes: 'n'.repeat(NOTES_MAX), size: MAX_BYTES }),
        visitor,
      ),
    ).resolves.toBeTruthy();
  });
});

describe('visitor caps', () => {
  it('returns 429 after 5 runs from one IP', async () => {
    for (let i = 0; i < 5; i++) await create({ sampleId: 'peek' }, visitor);
    const error = await rejection(create(upload(), visitor));
    expect(error.status).toBe(429);
    expect(error.message).toContain('5 runs per visitor');
    expect([...store.keys()].filter((k) => k.startsWith('jobs/'))).toHaveLength(5);
  });

  it('returns 429 once the daily public runs are spent', async () => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(
      new Date(),
    );
    store.set(`quota/${day}`, { runs: RUNS_PER_DAY, ips: {}, uploads: 0, visitorUploads: 0 });
    const error = await rejection(create({ sampleId: 'peek' }, visitor));
    expect(error.status).toBe(429);
    expect(error.message).toContain('40 public runs');
  });

  it('does not cap allowlisted sessions when the public runs are spent', async () => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(
      new Date(),
    );
    store.set(`quota/${day}`, { runs: RUNS_PER_DAY, ips: {}, uploads: 0, visitorUploads: 0 });
    await expect(create({ sampleId: 'peek' }, nathan)).resolves.toBeTruthy();
  });
});

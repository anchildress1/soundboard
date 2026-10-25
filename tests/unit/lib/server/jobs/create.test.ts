// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { jobs } from '#lib/server/core/schema.js';
import { ActionError } from '#lib/server/core/errors.js';
import { resetClients } from '#lib/server/core/clients.js';
import { create, MAX_BYTES, NOTES_MAX, type CreateInput } from '#lib/server/jobs/create.js';
import { getJob, type JobDoc } from '#lib/server/jobs/jobs.js';
import { seed, truncate } from '../../../../helpers/db';
import { omit } from '../../../../helpers/omit';
import { USER_A, USER_B, USERS } from '../../../../helpers/pipeline';

const SIGNED_PUT = 'https://storage/put';
const TOO_LONG = 'Videos are capped at 15 minutes.';
const TITLE_REQUIRED = 'Song title is required.';
const TOO_BIG = 'Videos must be under 2 GB.';

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

const job = async (id: string) => (await getJob(id)) as JobDoc;
const jobCount = async () => (await db().select().from(jobs)).length;

const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ActionError);
  return error as ActionError;
};

beforeEach(async () => {
  vi.stubEnv('GCP_PROJECT_ID', 'p');
  vi.stubEnv('GCS_BUCKET', 'b');
  resetClients();
  vi.clearAllMocks();
  gcs.files.length = 0;
  gcs.getSignedUrl.mockResolvedValue([SIGNED_PUT]);
  await truncate();
  await seed(USERS);
});

describe('create', () => {
  it("makes the user's job awaiting upload, with a signed upload URL", async () => {
    const { id, uploadUrl } = await create(upload(), USER_B);
    expect(uploadUrl).toBe(SIGNED_PUT);
    expect(gcs.files).toEqual([`uploads/${id}`]);
    expect(gcs.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'write', contentType: 'video/mp4' }),
    );
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await job(id)).toMatchObject({
      ownerUid: USER_B.uid,
      artistId: null,
      parentId: null,
      destination: null,
      uploadStartedAt: null,
      finalChunkAt: null,
      state: 'AWAITING_UPLOAD',
      object: `uploads/${id}`,
      songTitle: 'PeekaBoo',
      notes: 'first cut',
      filename: 'peekaboo.mp4',
    });
  });

  it("copies the owner's artist link", async () => {
    const { id } = await create(upload(), USER_A);
    expect(await job(id)).toMatchObject({ ownerUid: USER_A.uid, artistId: 'flr' });
  });

  it('trims the title and notes and caps the filename', async () => {
    const { id } = await create(
      upload({ songTitle: '  PeekaBoo  ', notes: '  n  ', filename: 'f'.repeat(300) }),
      USER_B,
    );
    expect((await job(id)).songTitle).toBe('PeekaBoo');
    expect((await job(id)).notes).toBe('n');
    expect((await job(id)).filename).toHaveLength(200);
  });

  it('defaults a missing filename and notes', async () => {
    const { id } = await create(omit(upload(), 'filename', 'notes') as CreateInput, USER_B);
    expect((await job(id)).filename).toBe('video');
    expect((await job(id)).notes).toBe('');
  });

  it('defaults a filename that is not text', async () => {
    const { id } = await create(upload({ filename: { name: 'x.mp4' } }), USER_B);
    expect((await job(id)).filename).toBe('video');
  });

  it('accepts a video at exactly 15 minutes and rejects one over, for every user', async () => {
    for (const user of [USER_A, USER_B]) {
      await expect(create(upload({ durationSec: 900 }), user)).resolves.toBeTruthy();
      const error = await rejection(create(upload({ durationSec: 901 }), user));
      expect([error.status, error.message]).toEqual([400, TOO_LONG]);
    }
  });

  it.each([
    ['a missing title', upload({ songTitle: '' }), TITLE_REQUIRED],
    ['a blank title', upload({ songTitle: '   ' }), TITLE_REQUIRED],
    ['an undefined title', omit(upload(), 'songTitle'), TITLE_REQUIRED],
    ['a boolean title', upload({ songTitle: true }), TITLE_REQUIRED],
    ['an object title', upload({ songTitle: { text: 'PeekaBoo' } }), TITLE_REQUIRED],
    [
      'a title over 100 chars',
      upload({ songTitle: 'x'.repeat(101) }),
      'Song title is over 100 characters.',
    ],
    [
      'notes over 1000 chars',
      upload({ notes: 'n'.repeat(NOTES_MAX + 1) }),
      'Notes are over 1000 characters.',
    ],
    ['a non-video type', upload({ contentType: 'audio/mpeg' }), 'Pick a video file.'],
    ['a missing type', omit(upload(), 'contentType'), 'Pick a video file.'],
    ['an array type', upload({ contentType: ['video/mp4'] }), 'Pick a video file.'],
    ['size 0', upload({ size: 0 }), TOO_BIG],
    ['size over 2 GB', upload({ size: MAX_BYTES + 1 }), TOO_BIG],
    ['a non-numeric size', upload({ size: 'big' }), TOO_BIG],
    ['a size sent as a string', upload({ size: '50000000' }), TOO_BIG],
    ['duration 0', upload({ durationSec: 0 }), TOO_LONG],
    ['a NaN duration', upload({ durationSec: 'long' }), TOO_LONG],
    ['a null duration', upload({ durationSec: null }), TOO_LONG],
    ['a duration in an array', upload({ durationSec: [180] }), TOO_LONG],
  ])('rejects %s with 400', async (_label, input, message) => {
    const error = await rejection(create(input as CreateInput, USER_B));
    expect(error.status).toBe(400);
    expect(error.message).toBe(message);
    expect(await jobCount()).toBe(0);
  });

  it('accepts the boundaries: 100-char title, 1000-char notes, exactly 2 GB', async () => {
    await expect(
      create(
        upload({ songTitle: 'x'.repeat(100), notes: 'n'.repeat(NOTES_MAX), size: MAX_BYTES }),
        USER_B,
      ),
    ).resolves.toBeTruthy();
  });
});

describe('failures', () => {
  it('stores no job when the upload URL cannot be signed', async () => {
    gcs.getSignedUrl.mockRejectedValueOnce(new Error('iam.serviceAccounts.signBlob denied'));
    await expect(create(upload(), USER_B)).rejects.toThrow('signBlob');
    expect(await jobCount()).toBe(0);
  });

  it('stores no job for an owner who is not a user', async () => {
    await expect(create(upload(), { uid: 'ghost', artistId: null })).rejects.toThrow();
    expect(await jobCount()).toBe(0);
  });
});

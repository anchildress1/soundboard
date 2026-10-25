// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/core/db.js';
import { jobs } from '#lib/server/core/schema.js';
import { ActionError } from '#lib/server/core/errors.js';
import { resetClients } from '#lib/server/core/clients.js';
import {
  create,
  MAX_BYTES,
  NOTES_MAX,
  parseMedia,
  type CreateInput,
} from '#lib/server/jobs/create.js';
import { getJob, type JobDoc } from '#lib/server/jobs/jobs.js';
import { KeyManagementServiceClient } from '../../../../e2e/fakes/kms';
import { seed, truncate } from '../../../../helpers/db';
import { deferred, gcs, resetGcs } from '../../../../helpers/gcs';
import { omit } from '../../../../helpers/omit';
import { sealed, USER_A, USER_B, USER_C, USERS } from '../../../../helpers/pipeline';

const ORIGIN = 'http://localhost:5173';
const TOO_LONG = 'Videos are capped at 15 minutes.';
const TITLE_REQUIRED = 'Song title is required.';
const TOO_BIG = 'Videos must be under 2 GB.';
const PICK_AGAIN = 'Pick the video again.';
const FP = 'c'.repeat(64);

vi.mock('@google-cloud/storage', () => import('../../../../helpers/gcs'));
vi.mock('@google-cloud/kms', () => import('../../../../e2e/fakes/kms'));

const upload = (over: Record<string, unknown> = {}): CreateInput =>
  ({
    songTitle: 'PeekaBoo',
    notes: 'first cut',
    filename: 'peekaboo.mp4',
    contentType: 'video/mp4',
    size: 50_000_000,
    durationSec: 180,
    fingerprint: FP,
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
  vi.stubEnv('KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  resetClients();
  resetGcs();
  await truncate();
  await seed(USERS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('create', () => {
  it("makes the user's job awaiting upload, with a resumable session for a fresh object", async () => {
    const created = await create(upload(), USER_C, ORIGIN);
    const { id } = created;
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const [session] = gcs.created;
    expect(session!.object).toMatch(new RegExp(`^uploads/${id}/[\\w-]{22}$`));
    expect(session!.options).toEqual({
      origin: ORIGIN,
      metadata: { contentType: 'video/mp4', contentLength: 50_000_000 },
    });
    const sessionUri = [...gcs.sessions.keys()][0]!;
    expect(created).toEqual({ id, sessionUri, generation: 1 });
    const stored = await job(id);
    expect(stored.videoUpload).toEqual({
      sessionCipher: sealed(sessionUri),
      generation: 1,
      size: 50_000_000,
      fingerprint: FP,
      ops: [],
    });
    expect(JSON.stringify(stored)).not.toContain(sessionUri);
    expect(stored).toMatchObject({
      ownerUid: USER_C.uid,
      artistId: USER_C.artistId,
      parentId: null,
      destination: null,
      uploadStartedAt: null,
      finalChunkAt: null,
      state: 'AWAITING_UPLOAD',
      object: session!.object,
      songTitle: 'PeekaBoo',
      notes: 'first cut',
      filename: 'peekaboo.mp4',
    });
  });

  it('refuses a user with no artist profile before opening a session, storing nothing', async () => {
    const error = await rejection(create(upload(), USER_B, ORIGIN));
    expect([error.status, error.message]).toEqual([409, 'Add your artist name first.']);
    expect(gcs.created).toHaveLength(0);
    expect(await jobCount()).toBe(0);
  });

  it("copies the owner's artist link", async () => {
    const { id } = await create(upload(), USER_A, ORIGIN);
    expect(await job(id)).toMatchObject({ ownerUid: USER_A.uid, artistId: 'flr' });
  });

  it('trims the title and notes and caps the filename', async () => {
    const { id } = await create(
      upload({ songTitle: '  PeekaBoo  ', notes: '  n  ', filename: 'f'.repeat(300) }),
      USER_C,
      ORIGIN,
    );
    expect((await job(id)).songTitle).toBe('PeekaBoo');
    expect((await job(id)).notes).toBe('n');
    expect((await job(id)).filename).toHaveLength(200);
  });

  it('defaults a missing filename and notes', async () => {
    const { id } = await create(omit(upload(), 'filename', 'notes') as CreateInput, USER_C, ORIGIN);
    expect((await job(id)).filename).toBe('video');
    expect((await job(id)).notes).toBe('');
  });

  it('defaults a filename that is not text', async () => {
    const { id } = await create(upload({ filename: { name: 'x.mp4' } }), USER_C, ORIGIN);
    expect((await job(id)).filename).toBe('video');
  });

  it('accepts a video at exactly 15 minutes and rejects one over, for every user', async () => {
    for (const user of [USER_A, USER_C]) {
      await expect(create(upload({ durationSec: 900 }), user, ORIGIN)).resolves.toBeTruthy();
      const error = await rejection(create(upload({ durationSec: 901 }), user, ORIGIN));
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
    ['a missing fingerprint', omit(upload(), 'fingerprint'), PICK_AGAIN],
    ['a short fingerprint', upload({ fingerprint: 'c'.repeat(63) }), PICK_AGAIN],
    ['an uppercase fingerprint', upload({ fingerprint: 'C'.repeat(64) }), PICK_AGAIN],
  ])('rejects %s with 400', async (_label, input, message) => {
    const error = await rejection(create(input as CreateInput, USER_C, ORIGIN));
    expect(error.status).toBe(400);
    expect(error.message).toBe(message);
    expect(await jobCount()).toBe(0);
    expect(gcs.created).toEqual([]);
  });

  it('accepts the boundaries: 100-char title, 1000-char notes, exactly 2 GB', async () => {
    await expect(
      create(
        upload({ songTitle: 'x'.repeat(100), notes: 'n'.repeat(NOTES_MAX), size: MAX_BYTES }),
        USER_C,
        ORIGIN,
      ),
    ).resolves.toBeTruthy();
  });
});

describe('failures', () => {
  it('stores no job when the session cannot be opened', async () => {
    gcs.createResumableUpload.mockRejectedValueOnce(new Error('storage.objects.create denied'));
    await expect(create(upload(), USER_C, ORIGIN)).rejects.toThrow('denied');
    expect(await jobCount()).toBe(0);
  });

  it('stores no job when opening the session outlives 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    gcs.createResumableUpload.mockReturnValueOnce(deferred<string>().promise);
    const pending = create(upload(), USER_C, ORIGIN).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({
      message: 'Opening the upload session took longer than 10000 ms',
    });
    vi.useRealTimers();
    expect(await jobCount()).toBe(0);
  });

  it('stores no job when the session cannot be sealed', async () => {
    vi.spyOn(KeyManagementServiceClient.prototype, 'encrypt').mockRejectedValueOnce(
      new Error('PERMISSION_DENIED'),
    );
    await expect(create(upload(), USER_C, ORIGIN)).rejects.toThrow('PERMISSION_DENIED');
    expect(await jobCount()).toBe(0);
  });

  it('stores no job for an owner who is not a user', async () => {
    await expect(
      create(upload(), { uid: 'ghost', artist: { id: 'flr' } }, ORIGIN),
    ).rejects.toThrow();
    expect(await jobCount()).toBe(0);
  });
});

describe('parseMedia', () => {
  const media = { filename: 'b.mp4', contentType: 'video/mp4', size: 1000, durationSec: 60 };

  it('passes a pick payload, which carries no song title', () => {
    expect(parseMedia(media)).toEqual({ contentType: 'video/mp4', size: 1000, filename: 'b.mp4' });
  });

  it.each([
    [{ contentType: 'audio/mpeg' }, 'Pick a video file.'],
    [{ size: MAX_BYTES + 1 }, TOO_BIG],
    [{ size: 0 }, TOO_BIG],
    [{ durationSec: 15 * 60 + 1 }, TOO_LONG],
    [{ durationSec: Number.NaN }, TOO_LONG],
  ])('refuses %o with today’s message', (over, message) => {
    expect(() => parseMedia({ ...media, ...over })).toThrow(message);
  });

  it('defaults and trims the file name', () => {
    expect(parseMedia({ ...media, filename: undefined as unknown as string }).filename).toBe(
      'video',
    );
    expect(parseMedia({ ...media, filename: 'x'.repeat(300) }).filename).toHaveLength(200);
  });

  it('leaves the song title to create', async () => {
    expect((await rejection(create(upload({ songTitle: '' }), USER_C, ORIGIN))).message).toBe(
      TITLE_REQUIRED,
    );
  });
});

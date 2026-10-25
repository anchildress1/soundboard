// An in-memory GCS for unit tests: objects by name, resumable sessions by URI, and the session HTTP
// the server sends with `fetch` (status query, cancel). Register it with
// `vi.mock('@google-cloud/storage', () => import('<path>/helpers/gcs'))` and stub `fetch` with
// `sessionFetch`. Every hook is a `vi.fn`, so tests can hold or fail a call.
import { vi } from 'vitest';

export type Session = { object: string; size: number; saved: number; cancelled: boolean };

export const gcs = {
  objects: new Map<string, { size: number; contentType: string }>(),
  sessions: new Map<string, Session>(),
  created: [] as { object: string; options: unknown }[],
  deleted: [] as string[],
  exists: vi.fn(async (object: string) => gcs.objects.has(object)),
  createResumableUpload: vi.fn(async (object: string, options: unknown) => {
    const uri = `https://storage.googleapis.com/upload/storage/v1/b/bkt/o?uploadType=resumable&upload_id=sess-${gcs.created.length + 1}`;
    gcs.created.push({ object, options });
    const size = (options as { metadata: { contentLength: number } }).metadata.contentLength;
    gcs.sessions.set(uri, { object, size, saved: 0, cancelled: false });
    return uri;
  }),
  getFiles: vi.fn(async (prefix: string) =>
    [...gcs.objects.keys()].filter((name) => name.startsWith(prefix)),
  ),
  delete: vi.fn(async (object: string) => {
    gcs.deleted.push(object);
    gcs.objects.delete(object);
  }),
  /** Answers a session request; replace to fail or hold one. */
  session: vi.fn(async (uri: string, init: RequestInit) => answer(uri, init)),
};

let seeded = 0;

/** A session that already exists, without going through `createResumableUpload`. */
export function seedSession(object: string, size: number, saved = 0): string {
  const uri = `https://storage.googleapis.com/upload/storage/v1/b/bkt/o?uploadType=resumable&upload_id=seeded-${++seeded}`;
  gcs.sessions.set(uri, { object, size, saved, cancelled: false });
  return uri;
}

/** Lands a session's object, as GCS does when its last byte arrives. */
export function land(uri: string): string {
  const session = gcs.sessions.get(uri)!;
  session.saved = session.size;
  gcs.objects.set(session.object, { size: session.size, contentType: 'video/mp4' });
  return session.object;
}

export function resetGcs(): void {
  gcs.objects.clear();
  gcs.sessions.clear();
  gcs.created.length = 0;
  gcs.deleted.length = 0;
  for (const hook of [
    gcs.exists,
    gcs.createResumableUpload,
    gcs.getFiles,
    gcs.delete,
    gcs.session,
  ]) {
    hook.mockReset();
  }
  sessionFetch.mockClear();
}

function answer(uri: string, init: RequestInit): Response {
  const session = gcs.sessions.get(uri);
  if (!session || session.cancelled) return new Response(null, { status: 404 });
  if (init.method === 'DELETE') {
    session.cancelled = true;
    return new Response(null, { status: 499 });
  }
  if (gcs.objects.has(session.object)) return new Response(null, { status: 200 });
  const headers = session.saved > 0 ? { range: `bytes=0-${session.saved - 1}` } : undefined;
  return new Response(null, { status: 308, headers });
}

/** `fetch` for the server's session requests; anything else is a test bug. */
export const sessionFetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
  const uri = String(input);
  if (!uri.includes('uploadType=resumable')) throw new Error(`Unexpected fetch ${uri}`);
  init.signal?.throwIfAborted();
  return await gcs.session(uri, init);
});

/** Stands in for `@google-cloud/storage`. */
export class Storage {
  bucket() {
    return {
      file: (object: string) => ({
        exists: async () => [await gcs.exists(object)],
        getMetadata: async () => [
          {
            size: String(gcs.objects.get(object)?.size ?? 0),
            contentType: gcs.objects.get(object)?.contentType,
          },
        ],
        createResumableUpload: async (options: unknown) => [
          await gcs.createResumableUpload(object, options),
        ],
        getSignedUrl: async () => [`https://storage.googleapis.com/bkt/${object}?sig=read`],
      }),
      getFiles: async ({ prefix }: { prefix: string }) => [
        (await gcs.getFiles(prefix)).map((name) => ({
          name,
          delete: async () => {
            await gcs.delete(name);
          },
        })),
      ],
    };
  }
}

/** A promise with its resolve and reject, for holding a boundary call mid-flight. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

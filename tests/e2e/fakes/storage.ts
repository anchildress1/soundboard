// Stands in for @google-cloud/storage in the E2E build. Browser uploads go to the fake session
// server (tests/e2e/fakes/gcs-session.ts), which owns every object an upload creates. Any other
// object reads as present, except those named "expired", which stand for media the bucket's 7-day
// lifecycle already deleted. Signed URLs are empty media, so the monitor loads nothing.
const SESSIONS = 'http://localhost:4174';

type Known = { landed: boolean; size: number; contentType: string };

/** The session server's record of `object`, or null when no upload ever created it. */
async function known(object: string): Promise<Known | null> {
  const response = await fetch(`${SESSIONS}/control/object/${encodeURIComponent(object)}`);
  return response.ok ? ((await response.json()) as Known) : null;
}

export class Storage {
  bucket() {
    return {
      file: (object: string) => ({
        getSignedUrl: async () => [`data:video/mp4;base64,#${object}`],
        exists: async () => {
          const record = await known(object);
          return [record ? record.landed : !object.includes('expired')];
        },
        getMetadata: async () => {
          const record = await known(object);
          return [record ? { size: String(record.size), contentType: record.contentType } : {}];
        },
        createResumableUpload: async ({
          metadata,
        }: {
          metadata: { contentType: string; contentLength: number };
        }) => {
          const response = await fetch(`${SESSIONS}/control/create`, {
            method: 'POST',
            body: JSON.stringify({
              object,
              size: metadata.contentLength,
              contentType: metadata.contentType,
            }),
          });
          const { uri } = (await response.json()) as { uri: string };
          return [uri];
        },
      }),
      getFiles: async ({ prefix }: { prefix: string }) => {
        const response = await fetch(
          `${SESSIONS}/control/objects?prefix=${encodeURIComponent(prefix)}`,
        );
        const listed = (await response.json()) as { name: string }[];
        return [
          listed.map(({ name }) => ({
            name,
            delete: async () => {
              await fetch(`${SESSIONS}/control/object/${encodeURIComponent(name)}`, {
                method: 'DELETE',
              });
            },
          })),
        ];
      },
      upload: async () => {
        throw new Error('E2E fake storage takes no uploads.');
      },
    };
  }
}

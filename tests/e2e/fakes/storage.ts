// Stands in for @google-cloud/storage in the E2E build. Signed URLs are empty media, so the monitor
// loads nothing; nothing is ever stored. Every object reads as present except those named "expired",
// which stand for media the bucket's 7-day lifecycle already deleted.
export class Storage {
  bucket() {
    return {
      file: (object: string) => ({
        getSignedUrl: async () => [`data:video/mp4;base64,#${object}`],
        exists: async () => [!object.includes('expired')],
        getMetadata: async () => [{}],
      }),
      upload: async () => {
        throw new Error('E2E fake storage takes no uploads.');
      },
    };
  }
}

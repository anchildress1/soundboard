/** A picked file waiting to upload, handed from the home page to its job page within one tab. */
export type PendingUpload = {
  file: File;
  uploadUrl: string;
  objectUrl: string;
  /** The type the upload URL was signed with; the PUT must send exactly this. */
  contentType: string;
};

const pending = new Map<string, PendingUpload>();

export function setPending(jobId: string, upload: PendingUpload): void {
  pending.set(jobId, upload);
}

export function takePending(jobId: string): PendingUpload | undefined {
  const upload = pending.get(jobId);
  pending.delete(jobId);
  return upload;
}

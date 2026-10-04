import type { BrandGuide, StoredBrand } from './brand';
import type { FieldErrors } from './metadata';
import type { JobView, Wait } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields: FieldErrors | null = null,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    fields?: FieldErrors;
  };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body.error ?? body.message ?? `Request failed (${response.status})`,
      body.fields ?? null,
    );
  }
  return body as T;
}

export type Trace = { sentryTrace: string; baggage: string } | null;

export type CreateBody =
  | { sampleId: string }
  | {
      songTitle: string;
      notes: string;
      filename: string;
      contentType: string;
      size: number;
      durationSec: number;
    };

export function createJob(body: CreateBody) {
  return call<{ id: string; uploadUrl: string | null }>('/api/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Explicit trace headers keep every step in the job's trace; Sentry never overrides them. */
const traceHeaders = (trace: Trace): Record<string, string> =>
  trace ? { 'sentry-trace': trace.sentryTrace, baggage: trace.baggage } : {};

export function step(id: string, trace: Trace) {
  return call<JobView>(`/api/jobs/${id}/step`, { method: 'POST', headers: traceHeaders(trace) });
}

export type ActionName = 'approve' | 'rerun' | 'discard' | 'retry' | 'recut' | 'short';

/** `short` starts the job's Short and returns the Short's view; every other action returns the job's. */
export function action(id: string, name: ActionName, trace: Trace, body: unknown = {}) {
  return call<JobView>(`/api/jobs/${id}/${name}`, {
    method: 'POST',
    headers: traceHeaders(trace),
    body: JSON.stringify(body),
  });
}

export function proposeBrand() {
  return call<{ wait: Wait } | { proposal: StoredBrand }>('/api/brand/propose', {
    method: 'POST',
  });
}

/** `proposedAt` is the reviewed proposal's `createdAt`, so a replaced proposal can't be approved. */
export function approveBrand(guide: BrandGuide, proposedAt: number) {
  return call<{ approved: StoredBrand }>('/api/brand/approve', {
    method: 'POST',
    body: JSON.stringify({ ...guide, proposedAt }),
  });
}

export function discardBrandProposal() {
  return call<{ proposal: null }>('/api/brand/discard', { method: 'POST' });
}

/** Signed PUT straight to GCS, with progress. The headers must match what the URL was signed with. */
export function uploadToGcs(
  url: string,
  file: File,
  contentType: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', contentType);
    xhr.setRequestHeader('x-goog-content-length-range', '1,2147483648');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status < 300
        ? resolve()
        : reject(new ApiError(xhr.status, `Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: network error'));
    xhr.send(file);
  });
}

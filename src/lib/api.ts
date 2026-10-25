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

/** A 409 from `upload-session`; `generation` is the current one when the server named it. */
export class UploadConflict extends ApiError {
  constructor(
    message: string,
    readonly generation: number | null,
  ) {
    super(409, message);
  }
}

/** `upload-session` didn't answer in time; the uploader resends the same body. */
export class SessionTimeout extends Error {
  constructor() {
    super('The upload service did not answer in time.');
  }
}

type ErrorBody = { error?: string; message?: string; fields?: FieldErrors; generation?: number };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const body = (await response.json().catch(() => ({}))) as ErrorBody;
  if (!response.ok) {
    const message = body.error ?? body.message ?? `Request failed (${response.status})`;
    if (response.status === 409 && path.endsWith('/upload-session')) {
      throw new UploadConflict(message, body.generation ?? null);
    }
    throw new ApiError(response.status, message, body.fields ?? null);
  }
  return body as T;
}

export type Trace = { sentryTrace: string; baggage: string } | null;

export type CreateBody = {
  songTitle: string;
  notes: string;
  filename: string;
  contentType: string;
  size: number;
  durationSec: number;
  fingerprint: string;
};

/** `sessionUri` is the upload credential: it goes to the uploader and nowhere else. */
export function createJob(body: CreateBody) {
  return call<{ id: string; sessionUri: string; generation: number }>('/api/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export type SessionOp =
  | {
      op: 'pick';
      opId: string;
      generation: number;
      size: number;
      fingerprint: string;
      filename: string;
      contentType: string;
      durationSec: number;
    }
  | { op: 'renew'; opId: string; generation: number; fingerprint: string }
  | { op: 'confirm'; generation: number; fingerprint: string };

/** A pick or renew carries the session URI; a confirm only says the sender is still current. */
export type SessionReply<O extends SessionOp> = O extends { op: 'confirm' }
  ? { current: true }
  : { sessionUri: string; generation: number; restarted: boolean };

const SESSION_MS = 10_000;

/** `POST /api/jobs/{id}/upload-session`, bounded at 10 s. */
export async function uploadSession<O extends SessionOp>(
  id: string,
  body: O,
): Promise<SessionReply<O>> {
  try {
    return await call<SessionReply<O>>(`/api/jobs/${id}/upload-session`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SESSION_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new SessionTimeout();
    throw error;
  }
}

/** Explicit trace headers keep every step in the job's trace; Sentry never overrides them. */
const traceHeaders = (trace: Trace): Record<string, string> =>
  trace ? { 'sentry-trace': trace.sentryTrace, baggage: trace.baggage } : {};

export function step(id: string, trace: Trace) {
  return call<JobView>(`/api/jobs/${id}/step`, { method: 'POST', headers: traceHeaders(trace) });
}

export type ActionName =
  'approve' | 'rerun' | 'discard' | 'retry' | 'recut' | 'short' | 'confirm-upload';

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

/** Always forgets the grant here; `revokedAtGoogle` is false when Google didn't confirm. */
export function disconnectYouTube() {
  return call<{ revokedAtGoogle: boolean }>('/api/connections/youtube/disconnect', {
    method: 'POST',
  });
}

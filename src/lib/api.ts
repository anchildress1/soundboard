import type { ArtistInput, ArtistValue } from './artist';
import type { Approved, BrandGuide, GuideKind, Proposal, VoiceRules } from './brand';
import type { Influence } from './influence';
import type { JobView, Wait } from './types';

/** Each field's message, keyed by the form's field names. */
type FormErrors = Partial<Record<string, string>>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields: FormErrors | null = null,
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

/**
 * The request got no response. fetch's own TypeError won't do: p-retry retries a TypeError only
 * when it looks like a network error, and in Safari, Sentry's fetch wrapper gives it a stack that
 * makes it look like a bug, so every retry loop gave up on the first drop.
 */
export class Unreachable extends Error {}

type ErrorBody = { error?: string; message?: string; fields?: FormErrors; generation?: number };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
  } catch (error) {
    // fetch rejects with a TypeError when no response arrived; an abort stays a DOMException.
    if (error instanceof TypeError) throw new Unreachable(error.message, { cause: error });
    throw error;
  }
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

/** Each guide kind's body. */
export type GuideBody = { voice: VoiceRules; brand: BrandGuide };

/** A proposal step's answer: the new proposal, or a wait (`limitUntil` with a spent quota). */
export type ProposeAnswer<K extends GuideKind> =
  { proposal: Proposal<GuideBody[K]> } | { wait: Wait; limitUntil?: number };

export function proposeGuide<K extends GuideKind>(kind: K) {
  return call<ProposeAnswer<K>>(`/api/guides/${kind}/propose`, { method: 'POST' });
}

/** `proposalId` names the reviewed proposal, so a replaced or approved one is a 404. */
export function approveGuide<K extends GuideKind>(kind: K, body: GuideBody[K], proposalId: number) {
  return call<{ approved: Approved<GuideBody[K]> }>(`/api/guides/${kind}/approve`, {
    method: 'POST',
    body: JSON.stringify({ ...body, proposalId }),
  });
}

export function discardGuide(kind: GuideKind, proposalId: number) {
  return call<{ proposal: null }>(`/api/guides/${kind}/discard`, {
    method: 'POST',
    body: JSON.stringify({ proposalId }),
  });
}

/** Creates or updates the caller's artist profile; a 422 carries per-field errors. */
export function saveArtist(body: ArtistInput) {
  return call<{ artist: ArtistValue }>('/api/artist', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** Saves the peer-influence settings on the approved brand guide; a 409 means there is none. */
export function saveInfluence(influence: Influence) {
  return call<{ influence: Influence }>('/api/influence', {
    method: 'PUT',
    body: JSON.stringify(influence),
  });
}

/**
 * "Not a peer" on pick `version`: later research skips the peer's channel. A 409 means its evidence
 * has expired or a newer pick replaced it.
 */
export function rejectPeer(id: string, ref: string, version: number) {
  return call<{ rejected: string }>(`/api/jobs/${id}/peers/${encodeURIComponent(ref)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ version }),
  });
}

/** Always forgets the grant here; `revokedAtGoogle` is false when Google didn't confirm. */
export function disconnectYouTube() {
  return call<{ revokedAtGoogle: boolean }>('/api/connections/youtube/disconnect', {
    method: 'POST',
  });
}

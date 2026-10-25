// The browser side of the resumable upload, owned by the app rather than a page, so in-app navigation
// keeps it sending. The session URI is a bearer credential: it stays in memory here, never in a
// breadcrumb, browser storage or an error.
import { addBreadcrumb } from '@sentry/sveltekit';
import { get, writable } from 'svelte/store';
import { ApiError, SessionTimeout, UploadConflict, uploadSession } from './api';
import { UPLOAD_BACKOFF } from './retry';
import type { PauseReason } from './status';

export type UploadState = 'sending' | 'paused' | 'away' | 'replaced' | 'moved' | 'stopped' | 'done';

/** One job's upload in this tab. `saved` is what GCS confirmed, or live bytes sent while sending. */
export type Upload = {
  file: File;
  sessionUri: string;
  generation: number;
  fingerprint: string;
  size: number;
  saved: number;
  state: UploadState;
  reason: PauseReason | null;
  /** Why the upload started over, shown while it sends. */
  notice: 'new-video' | 'renewed' | null;
  /** The message a stop ended on. */
  error: string | null;
};

export type StartInput = Pick<Upload, 'file' | 'sessionUri' | 'generation' | 'fingerprint'> & {
  notice?: Upload['notice'];
};

/** A GCS reply, or the timer that gave up on one. */
export type Reply =
  { status: number; range: string | null } | { timeout: 'timeout' | 'stall' | 'no-reply' };

/** What the uploader does next (contract "Browser ↔ GCS"). */
export type Next =
  | { do: 'done' }
  | { do: 'send'; offset: number }
  | { do: 'pause'; reason: PauseReason }
  | { do: 'renew' }
  | { do: 'fail'; message: string };

type Step = Next | { do: 'conflict'; message: string; generation: number | null };

// The server's 409 messages (contract), which decide where a stopped upload goes next.
export const REPLACED = 'A different video replaced this upload.';
export const MOVED = 'The upload moved to another device or window.';
export const DISCARDED = 'This job was discarded.';
export const ALREADY_DONE = 'This upload is already done.';

const QUERY_MS = 15_000;
const STALL_MS = 60_000;
const CONFIRM_EVERY_MS = 30_000;
const RANGE = /^bytes=0-(\d+)$/;

/** The contract's row for one reply. */
export function nextAction(reply: Reply, size: number): Next {
  if ('timeout' in reply) return { do: 'pause', reason: reply.timeout };
  const { status, range } = reply;
  if (status === 200 || status === 201) return { do: 'done' };
  if (status === 308) {
    if (!range) return { do: 'send', offset: 0 };
    const match = RANGE.exec(range);
    const offset = match ? Number(match[1]) + 1 : Number.NaN;
    // A Range covering every byte isn't a documented answer: ask again later.
    return offset < size ? { do: 'send', offset } : { do: 'pause', reason: '5xx' };
  }
  if (status === 0) return { do: 'pause', reason: 'offline' };
  if (status === 408) return { do: 'pause', reason: '408' };
  if (status === 429) return { do: 'pause', reason: '429' };
  if (status === 404 || status === 410 || status === 499) return { do: 'renew' };
  if (status >= 400 && status < 500) return { do: 'fail', message: `Upload failed (${status})` };
  return { do: 'pause', reason: '5xx' };
}

type Run = {
  stopped: boolean;
  xhr: XMLHttpRequest | null;
  wake: (() => void) | null;
  retries: number;
  pausedFor: PauseReason | null;
  hiddenSaved: number | null;
  renewOpId: string | null;
};

const store = writable<Record<string, Upload>>({});
/** Every upload in this tab, by job ID. */
export const uploads = { subscribe: store.subscribe };

const runs = new Map<string, Run>();
const held = new Map<string, () => void>();

const lockName = (jobId: string) => `upload:${jobId}`;
const entry = (jobId: string): Upload => get(store)[jobId]!;
const patch = (jobId: string, fields: Partial<Upload>) =>
  store.update((all) => ({ ...all, [jobId]: { ...all[jobId]!, ...fields } }));

/** A request ID, stable across one request's retries. */
export const newOpId = (): string => crypto.randomUUID();

function appStep(error: unknown): Step {
  if (error instanceof UploadConflict) {
    return { do: 'conflict', message: error.message, generation: error.generation };
  }
  if (error instanceof SessionTimeout) return { do: 'pause', reason: 'timeout' };
  if (error instanceof ApiError) {
    if (error.status === 408) return { do: 'pause', reason: '408' };
    if (error.status === 429) return { do: 'pause', reason: '429' };
    if (error.status >= 500) return { do: 'pause', reason: '5xx' };
    return { do: 'fail', message: error.message };
  }
  // fetch rejects only when no response arrived.
  return { do: 'pause', reason: 'offline' };
}

async function confirm(jobId: string): Promise<Step | null> {
  const { generation, fingerprint } = entry(jobId);
  try {
    await uploadSession(jobId, { op: 'confirm', generation, fingerprint });
    return null;
  } catch (error) {
    return appStep(error);
  }
}

/** Renews a session GCS no longer has; one `opId` covers every retry until it answers. */
async function renew(jobId: string, run: Run): Promise<Step | null> {
  const { generation, fingerprint } = entry(jobId);
  run.renewOpId ??= newOpId();
  try {
    const reply = await uploadSession(jobId, {
      op: 'renew',
      opId: run.renewOpId,
      generation,
      fingerprint,
    });
    run.renewOpId = null;
    if (!run.stopped) {
      patch(jobId, {
        sessionUri: reply.sessionUri,
        generation: reply.generation,
        saved: 0,
        notice: 'renewed',
      });
    }
    return null;
  } catch (error) {
    return appStep(error);
  }
}

/** One XHR to the session. `configure` sets headers and timers; `settle` ends it once. */
function request(
  run: Run,
  upload: Upload,
  configure: (xhr: XMLHttpRequest, settle: (step: Step) => void) => void,
  body?: Blob,
): Promise<Step> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const settle = (step: Step) => {
      if (settled) return;
      settled = true;
      run.xhr = null;
      resolve(step);
      xhr.abort();
    };
    const answer = () =>
      settle(
        nextAction({ status: xhr.status, range: xhr.getResponseHeader('range') }, upload.size),
      );
    xhr.onload = answer;
    xhr.onerror = () => settle(nextAction({ status: 0, range: null }, upload.size));
    xhr.onabort = () => settle({ do: 'pause', reason: 'offline' });
    xhr.open('PUT', upload.sessionUri);
    configure(xhr, settle);
    run.xhr = xhr;
    xhr.send(body);
  });
}

/** The status query: how much GCS saved. */
function query(run: Run, upload: Upload): Promise<Step> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return request(run, upload, (xhr, settle) => {
    xhr.setRequestHeader('content-range', `bytes */${upload.size}`);
    timer = setTimeout(() => settle({ do: 'pause', reason: 'timeout' }), QUERY_MS);
  }).finally(() => clearTimeout(timer));
}

/** One PUT of everything from `offset`, watched for stalls and confirmed every 30 s. */
function send(jobId: string, run: Run, upload: Upload, offset: number): Promise<Step> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let confirming: ReturnType<typeof setInterval> | undefined;
  return request(
    run,
    upload,
    (xhr, settle) => {
      const arm = (reason: 'stall' | 'no-reply') => {
        clearTimeout(timer);
        timer = setTimeout(() => settle({ do: 'pause', reason }), STALL_MS);
      };
      xhr.setRequestHeader('content-range', `bytes ${offset}-${upload.size - 1}/${upload.size}`);
      xhr.upload.onprogress = (event) => {
        progress(jobId, run, offset + event.loaded);
        arm(event.loaded >= event.total ? 'no-reply' : 'stall');
      };
      xhr.upload.onload = () => arm('no-reply');
      confirming = setInterval(() => {
        void confirm(jobId).then((step) => step && settle(step));
      }, CONFIRM_EVERY_MS);
      arm('stall');
    },
    upload.file.slice(offset),
  ).finally(() => {
    clearTimeout(timer);
    clearInterval(confirming);
  });
}

/** Returned once `stop` ran mid-attempt; `drive` sees `run.stopped` and ignores it. */
const HALTED: Step = { do: 'pause', reason: 'offline' };

/** Confirm, query, send: one attempt, ending in what to do next. */
async function attempt(jobId: string, run: Run): Promise<Step> {
  if (run.renewOpId) {
    const failed = await renew(jobId, run);
    if (failed) return failed;
    if (run.stopped) return HALTED;
  }
  const unconfirmed = await confirm(jobId);
  if (unconfirmed) return unconfirmed;
  if (run.stopped) return HALTED;
  const queried = await query(run, entry(jobId));
  if (queried.do !== 'send' || run.stopped) return queried;
  patch(jobId, { saved: queried.offset });
  const sent = await send(jobId, run, entry(jobId), queried.offset);
  // A PUT that GCS cut short without saving anything more would loop at once: wait instead.
  return sent.do === 'send' && sent.offset <= queried.offset
    ? { do: 'pause', reason: '5xx' }
    : sent;
}

function progress(jobId: string, run: Run, saved: number) {
  const upload = entry(jobId);
  run.retries = 0;
  patch(jobId, { saved, state: 'sending', reason: null });
  if (run.pausedFor) {
    addBreadcrumb({
      category: 'upload',
      message: 'upload resumed',
      data: { saved, total: upload.size, reason: run.pausedFor },
    });
    run.pausedFor = null;
  }
}

function pause(jobId: string, run: Run, reason: PauseReason) {
  const upload = entry(jobId);
  patch(jobId, { state: upload.state === 'away' ? 'away' : 'paused', reason });
  if (!run.pausedFor) {
    addBreadcrumb({
      category: 'upload',
      message: 'upload paused',
      data: { saved: upload.saved, total: upload.size, reason },
    });
  }
  run.pausedFor = reason;
}

/** Waits out the backoff, or less when the link or the tab comes back. */
function backoff(run: Run): Promise<void> {
  const { minTimeout, factor, maxTimeout } = UPLOAD_BACKOFF;
  const ms = Math.min(maxTimeout, minTimeout * factor ** run.retries);
  run.retries++;
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    run.wake = done;
    function done() {
      clearTimeout(timer);
      run.wake = null;
      resolve();
    }
  });
}

function halt(run: Run) {
  run.stopped = true;
  run.xhr?.abort();
  run.wake?.();
}

function end(jobId: string, run: Run, fields: Partial<Upload>) {
  halt(run);
  runs.delete(jobId);
  release(jobId);
  patch(jobId, fields);
}

async function drive(jobId: string, run: Run) {
  while (!run.stopped) {
    const next = await attempt(jobId, run);
    if (run.stopped) return;
    switch (next.do) {
      case 'done':
        // The job page moves the job on: now, or when it next opens.
        end(jobId, run, { state: 'done', saved: entry(jobId).size, reason: null });
        return;
      case 'conflict': {
        const state =
          next.message === REPLACED ? 'replaced' : next.message === MOVED ? 'moved' : 'stopped';
        const generation = next.generation ?? entry(jobId).generation;
        end(jobId, run, { state, error: next.message, generation });
        return;
      }
      case 'fail':
        end(jobId, run, { state: 'stopped', error: next.message });
        return;
      case 'renew':
        run.renewOpId = newOpId();
        break;
      case 'pause':
        pause(jobId, run, next.reason);
        await backoff(run);
        break;
      case 'send':
        // GCS kept more of the PUT; go again at once.
        break;
    }
  }
}

let listening = false;

function onVisibility() {
  const visible = document.visibilityState === 'visible';
  for (const [jobId, run] of runs) {
    const upload = entry(jobId);
    if (!visible) {
      run.hiddenSaved = upload.saved;
      continue;
    }
    const idle = run.hiddenSaved === upload.saved;
    if (idle && (upload.state === 'sending' || upload.state === 'paused')) {
      patch(jobId, { state: 'away' });
    }
    run.hiddenSaved = null;
    run.wake?.();
  }
}

function listen() {
  if (listening) return;
  listening = true;
  globalThis.addEventListener('online', () => {
    for (const run of runs.values()) run.wake?.();
  });
  document.addEventListener('visibilitychange', onVisibility);
}

/**
 * Starts (or restarts, after a re-pick) sending a job's file. The caller holds the job's lock
 * (`acquire`) and got `sessionUri` and `generation` from create or `upload-session`.
 */
export function start(jobId: string, input: StartInput): void {
  listen();
  const previous = runs.get(jobId);
  if (previous) halt(previous);
  const run: Run = {
    stopped: false,
    xhr: null,
    wake: null,
    retries: 0,
    pausedFor: null,
    hiddenSaved: null,
    renewOpId: null,
  };
  runs.set(jobId, run);
  store.update((all) => ({
    ...all,
    [jobId]: {
      file: input.file,
      sessionUri: input.sessionUri,
      generation: input.generation,
      fingerprint: input.fingerprint,
      size: input.file.size,
      saved: 0,
      state: 'sending',
      reason: null,
      notice: input.notice ?? null,
      error: null,
    },
  }));
  void drive(jobId, run);
}

/** Aborts the job's upload in this tab, forgets it and releases the lock. Safe to call twice. */
export function stop(jobId: string): void {
  const run = runs.get(jobId);
  if (run) halt(run);
  runs.delete(jobId);
  release(jobId);
  store.update((all) => {
    const rest = { ...all };
    delete rest[jobId];
    return rest;
  });
}

/** Takes the job's lock if no tab holds it; true when this tab now holds it. */
export function acquire(jobId: string): Promise<boolean> {
  if (held.has(jobId)) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(lockName(jobId), { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        resolve(true);
        return new Promise<void>((done) => held.set(jobId, done));
      })
      .catch(reject);
  });
}

/** Whether another tab holds the job's lock. */
export async function holder(jobId: string): Promise<boolean> {
  if (held.has(jobId)) return false;
  const { held: locks = [] } = await navigator.locks.query();
  return locks.some((lock) => lock.name === lockName(jobId));
}

/** Queues for the job's lock; `onTakeover` runs once this tab holds it. Aborting leaves the queue. */
export function waitFor(jobId: string, signal: AbortSignal, onTakeover: () => void): void {
  navigator.locks
    .request(lockName(jobId), { signal }, () => {
      onTakeover();
      return new Promise<void>((done) => held.set(jobId, done));
    })
    // Rejects only on abort: the page that queued is gone.
    .catch(() => undefined);
}

function release(jobId: string) {
  held.get(jobId)?.();
  held.delete(jobId);
}

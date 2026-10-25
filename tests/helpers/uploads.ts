// Browser boundaries the uploader (src/lib/upload.ts) talks to: XMLHttpRequest to the GCS session
// and Web Locks. `installUploadFakes` puts fresh ones in place.
import { vi } from 'vitest';

/** XMLHttpRequest as the uploader uses it; tests answer each request by hand or via `handler`. */
export class FakeXhr {
  static all: FakeXhr[] = [];
  static handler: ((xhr: FakeXhr) => void) | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: Blob | undefined;
  status = 0;
  done = false;
  aborted = false;
  responseHeaders: Record<string, string> = {};
  upload: {
    onprogress: ((event: { loaded: number; total: number }) => void) | null;
    onload: (() => void) | null;
  } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }
  send(body?: Blob) {
    this.body = body;
    FakeXhr.all.push(this);
    const handler = FakeXhr.handler;
    if (handler) queueMicrotask(() => handler(this));
  }
  abort() {
    if (this.done) return;
    this.done = true;
    this.aborted = true;
    this.onabort?.();
  }

  get isQuery() {
    return this.headers['content-range']!.startsWith('bytes */');
  }
  respond(status: number, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseHeaders = headers;
    this.done = true;
    this.onload?.();
  }
  drop() {
    this.done = true;
    this.onerror?.();
  }
  progress(loaded: number) {
    this.upload.onprogress?.({ loaded, total: this.body!.size });
  }
}

/** Web Locks shared by every "tab" (module instance) in a test. */
export class FakeLocks {
  holders = new Set<string>();
  queue: { name: string; grant: () => void }[] = [];

  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: { name: string } | null) => unknown,
  ): Promise<unknown> {
    if (!this.holders.has(name)) return this.grant(name, callback);
    if (options.ifAvailable) return Promise.resolve(callback(null));
    return new Promise((resolve, reject) => {
      const waiting = { name, grant: () => this.grant(name, callback).then(resolve, reject) };
      this.queue.push(waiting);
      options.signal?.addEventListener('abort', () => {
        this.queue = this.queue.filter((item) => item !== waiting);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  }

  private grant(name: string, callback: (lock: { name: string }) => unknown): Promise<unknown> {
    this.holders.add(name);
    return Promise.resolve(callback({ name })).finally(() => {
      this.holders.delete(name);
      const next = this.queue.find((item) => item.name === name);
      if (next) {
        this.queue = this.queue.filter((item) => item !== next);
        next.grant();
      }
    });
  }

  async query() {
    return { held: [...this.holders].map((name) => ({ name })), pending: [] };
  }
}

/** Stubs XMLHttpRequest and `navigator.locks` with fresh fakes; returns the locks. */
export function installUploadFakes(): FakeLocks {
  FakeXhr.all = [];
  FakeXhr.handler = null;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  const locks = new FakeLocks();
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
  return locks;
}

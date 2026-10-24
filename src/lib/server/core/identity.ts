import { AsyncLocalStorage } from 'node:async_hooks';

const identity = new AsyncLocalStorage<string | undefined>();

/** Runs an operation under the verified Google account, without reserving a connection. */
export function withIdentity<T>(uid: string | undefined, operation: () => T): T {
  return identity.run(uid, operation);
}

/** The verified Google account for this asynchronous operation, if signed in. */
export function currentIdentity(): string | undefined {
  return identity.getStore();
}

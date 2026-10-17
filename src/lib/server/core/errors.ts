import type { FieldErrors } from '$lib/metadata';

/** An expected request failure: `respond` sends its status, message, and field errors as JSON. */
export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields?: FieldErrors,
  ) {
    super(message);
  }
}

import type { FieldErrors } from '#lib/metadata.js';

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

/**
 * Whether Google's token endpoint refused the grant: a used or expired code, or a revoked refresh
 * token. Read from the response body: the library rewrites the message for reauth-required grants.
 */
export const invalidGrant = (error: unknown): boolean =>
  (error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ===
  'invalid_grant';

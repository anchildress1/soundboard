/** An expected request failure: `respond` sends its status, message, and field errors as JSON. */
export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Messages keyed by form field. */
    readonly fields?: Partial<Record<string, string>>,
  ) {
    super(message);
  }
}

/** The refusal and wait for a user who hasn't saved an artist profile yet. */
export const NO_ARTIST = 'Add your artist name first.';

/**
 * Whether Google's token endpoint refused the grant: a used or expired code, or a revoked refresh
 * token. Read from the response body: the library rewrites the message for reauth-required grants.
 */
export const invalidGrant = (error: unknown): boolean =>
  (error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ===
  'invalid_grant';

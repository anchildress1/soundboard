/** A runtime check for one field of a model reply. */
export type Check = (value: unknown) => boolean;

export const isString: Check = (value) => typeof value === 'string';
export const isFiniteNumber: Check = (value) => Number.isFinite(value);
export const isStrings: Check = (value) => Array.isArray(value) && value.every(isString);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An object whose listed fields each pass their check; fields it doesn't list are ignored. */
export const shape =
  (fields: Record<string, Check>): Check =>
  (value) =>
    isRecord(value) && Object.entries(fields).every(([key, check]) => check(value[key]));

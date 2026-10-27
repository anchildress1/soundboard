/** The five parts of a draft a peer can influence, in Settings order. */
export const ROLES = ['sound', 'feel', 'wording', 'discovery', 'structure'] as const;

export type Role = (typeof ROLES)[number];

export type Level = 0 | 1 | 2 | 3 | 4;

/** Per role, 0 = only the artist's own sources, 4 = the strongest peer influence. */
export type Influence = Record<Role, Level>;

export const DEFAULT_INFLUENCE: Influence = {
  sound: 1,
  feel: 0,
  wording: 0,
  discovery: 4,
  structure: 4,
};

export const INFLUENCE_ERROR = 'Each setting is a whole number from 0 to 4.';

/** `INFLUENCE_ERROR` unless `value` has exactly the five roles, each a whole number 0–4. */
export function influenceError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return INFLUENCE_ERROR;
  const entries = Object.entries(value);
  const valid =
    entries.length === ROLES.length &&
    ROLES.every((role) => {
      const level = (value as Record<string, unknown>)[role];
      return Number.isInteger(level) && (level as number) >= 0 && (level as number) <= 4;
    });
  return valid ? null : INFLUENCE_ERROR;
}

/** R12: the newest uploads and thumbnails one proposal reads. */
export const BRAND_VIDEOS = 30;
export const BRAND_THUMBNAILS = 10;
export const STATEMENT_MAX = 500;
export const RULE_MAX = 160;
export const RULES_MAX = 6;

export type BrandGuide = { statement: string; keep: string[]; fix: string[]; drop: string[] };
export type StoredBrand = BrandGuide & {
  status: 'PROPOSED' | 'APPROVED';
  basedOn: string[];
  createdAt: number;
  approvedAt: number | null;
};

/** Splits a rules textarea, one rule per line. */
export function splitRules(field: string): string[] {
  return field
    .split('\n')
    .map((rule) => rule.trim())
    .filter(Boolean);
}

/** The first problem with an edited guide, or null. */
export function guideError(guide: BrandGuide): string | null {
  const statement = guide.statement.trim();
  if (!statement) return 'The brand statement is required.';
  if (statement.length > STATEMENT_MAX) return `The statement is over ${STATEMENT_MAX} characters.`;
  for (const [name, rules] of [
    ['Keep', guide.keep],
    ['Fix', guide.fix],
    ['Drop', guide.drop],
  ] as const) {
    if (rules.length > RULES_MAX) return `${name} has more than ${RULES_MAX} rules.`;
    if (rules.some((r) => r.trim().length > RULE_MAX)) {
      return `A ${name.toLowerCase()} rule is over ${RULE_MAX} characters.`;
    }
  }
  return null;
}

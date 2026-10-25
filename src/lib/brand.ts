/** R12: the newest uploads and thumbnails one proposal reads. */
export const BRAND_VIDEOS = 30;
export const BRAND_THUMBNAILS = 10;
export const STATEMENT_MAX = 500;
export const RULE_MAX = 160;
export const RULES_MAX = 6;

export type BrandGuide = { statement: string; keep: string[]; fix: string[]; drop: string[] };
/** Voice rules: how the artist writes, one rule per entry. */
export type VoiceRules = { rules: string[] };
export const VOICE_RULES_MAX = 12;
export const VOICE_RULE_MAX = 240;
/** R5: the newest uploads one voice proposal reads. */
export const VOICE_UPLOADS = 30;

export type GuideKind = 'voice' | 'brand';
export type UploadSource = { videoId: string; title: string; publishedAt: string };
/** What a pending proposal read; it expires with the proposal. */
export type ProposalSources = {
  uploads: UploadSource[];
  /** Approved Soundboard drafts the voice read at lower weight; always empty for brand. */
  drafts: UploadSource[];
  edits: number;
  approvals: number;
  thin: boolean;
};
/** What an approved version keeps of its sources: counts only, never video IDs or titles. */
export type SourceSummary = {
  uploads: number;
  drafts: number;
  edits: number;
  approvals: number;
  carriedOver: boolean;
};
export type Proposal<B> = { id: number; body: B; sources: ProposalSources; proposedAt: string };
export type Approved<B> = {
  body: B;
  sources: SourceSummary;
  proposedAt: string;
  approvedAt: string;
};
/** One kind's approved version, pending proposal, and the model quota hold (epoch ms). */
export type GuideState<B> = {
  approved: Approved<B> | null;
  proposal: Proposal<B> | null;
  limitUntil: number | null;
};

/** `n` and the noun, plural unless `n` is 1: "1 upload", "3 edits". */
export const counted = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

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

/** The first problem with edited voice rules, or null. */
export function voiceError(voice: VoiceRules): string | null {
  if (voice.rules.length === 0) return 'Add at least one voice rule.';
  if (voice.rules.length > VOICE_RULES_MAX) return `Voice has more than ${VOICE_RULES_MAX} rules.`;
  if (voice.rules.some((r) => r.trim().length > VOICE_RULE_MAX)) {
    return `A voice rule is over ${VOICE_RULE_MAX} characters.`;
  }
  return null;
}

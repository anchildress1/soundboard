// What review shows about a pick's evidence (contract "Review data"), and the plain labels for it.
import type { Influence, Role } from './influence';
import type { Calculated, Recommendation } from './types';

/** A decade range's lower bound (`research/brackets.ts`). */
export type Range = 0 | 100 | 1000 | 10000 | 100000 | 1000000;

/** A source a pick cited, resolved for display; `expired` once its evidence is hidden or deleted. */
export type Citation =
  | { ref: string; label: string }
  | { ref: string; expired: true; kind: 'peer' | 'result'; expiresAt: string | null };

export type PeerStats = {
  /** `'hidden'` when the channel hides its count; null when YouTube returned none. */
  subscribers: number | 'hidden' | null;
  videos: number | null;
  views: number | null;
};

export type ReviewRelease = {
  ref: string;
  title: string;
  url: string;
  selectedAs: 'newest' | 'most-viewed' | 'most-engaged';
  stats: { views: number | null; likes: number | null; comments: number | null };
  engagement: Calculated;
  publishedAt: string;
};

export type ReviewPeer = {
  ref: string;
  title: string;
  basis: 'heard' | 'metadata-only';
  secondary: boolean;
  explanation: string;
  relation: 'same' | 'next' | 'two-up' | null;
  stats: PeerStats;
  retrievedAt: string;
  releases: ReviewRelease[];
};

/** One of the artist's own results (YouTube Analytics), as reported plus the calculated net. */
export type ReviewResult = {
  ref: string;
  title: string;
  requested: { start: string; end: string };
  coverage: 'open' | 'complete' | 'unknown';
  metrics: {
    views: number | null;
    subscribersGained: number | null;
    subscribersLost: number | null;
  };
  net: Calculated;
};

export type FieldName = 'title' | 'description' | 'tags';

export type ReviewData = {
  /** The pick these peers belong to; a rejection names it, so a stale page can't reject another. */
  version: number;
  recommendation: Recommendation | null;
  /** `recommendation.evidence`, resolved. */
  evidence: Citation[];
  influence: Influence | null;
  influenceWarning: string | null;
  /** What the draft couldn't use, as the server built it; the reason when there is no recommendation. */
  limits: string[];
  /** Null when the artist's count is hidden or the evidence is gone. */
  ranges: { current: Range; target: Range | null } | null;
  /** Null once the pick's evidence is hidden or deleted. */
  peers: ReviewPeer[] | null;
  evidenceExpiresAt: string | null;
  results: ReviewResult[];
  /** The sources behind each field, from the roles that shape it. */
  sources: Record<FieldName, Citation[]>;
};

/** The roles whose sources shape each field a person reviews. */
export const FIELD_ROLES: Record<FieldName, Role[]> = {
  title: ['wording', 'feel', 'structure'],
  description: ['sound', 'feel', 'wording', 'structure'],
  tags: ['discovery', 'sound'],
};

const SOURCE_LABELS: Record<string, string> = {
  analysis: 'Song analysis',
  voice: 'Your voice guide',
  edits: 'Your past edits',
  identity: 'Your recent uploads',
};

/** The label for a ref that isn't evidence: the analysis, the artist's own writing, a genre list. */
export function sourceLabel(ref: string): string {
  const genre = /^G(\d+)$/.exec(ref);
  return SOURCE_LABELS[ref] ?? (genre ? `Genre search ${ref}` : ref);
}

/** `Nov 23, 2026` for an ISO instant, in UTC so the date matches what was stored. */
export function dateLabel(iso: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(iso),
  );
}

/** The sentence for a citation, expired ones included. */
export function citationText(citation: Citation): string {
  if (!('expired' in citation)) return citation.label;
  if (citation.kind === 'result') return 'Result no longer stored';
  return citation.expiresAt
    ? `Peer evidence expired on ${dateLabel(citation.expiresAt)}`
    : 'Peer evidence expired';
}

/** A reported subscriber range such as `1,000–9,999`. */
export function rangeLabel(range: Range): string {
  const high: Record<Range, number | null> = {
    0: 99,
    100: 999,
    1000: 9999,
    10000: 99999,
    100000: 999999,
    1000000: null,
  };
  const top = high[range];
  const n = (value: number) => value.toLocaleString('en-US');
  return top === null ? `${n(range)} or more` : `${n(range)}–${n(top)}`;
}

/** Plain sentences for the limit codes the server records. */
const LIMIT_TEXT: Record<string, string> = {
  'research-unavailable': 'Peer research is unavailable; this draft uses the genre search only.',
  'research-unfinished': "Peer research didn't finish; this draft uses what was found.",
  'analytics-not-shared': 'Your YouTube Analytics results are not shared, so none were used.',
  'youtube-not-connected': 'YouTube was not connected for research, so your results were not read.',
  'private-releases': 'Private and unlisted releases were left out of your results.',
  'few-peers': 'Fewer than three similar artists were found.',
  'no-peers': 'No similar artists were found.',
  'hearing-off': 'Similar artists were matched on their titles and tags, not by listening.',
  'same-range-fallback': 'Fell back to artists in your own range.',
  'artist-range-unknown': 'Your subscriber count is hidden, so artists were not placed by range.',
  'peer-range-unknown': "Some similar artists hide their subscriber counts and weren't used.",
  'secondary-only': 'No recommendation: only secondary evidence supported it.',
  'genre-search-unavailable': 'The genre search was unavailable, so no genre evidence was used.',
};

export const limitText = (code: string): string => LIMIT_TEXT[code] ?? code;

/** `1,234` for a reported count, a plain word when YouTube gave none. */
export function countLabel(value: number | 'hidden' | null): string {
  if (value === 'hidden') return 'hidden';
  return value === null ? 'not reported' : value.toLocaleString('en-US');
}

/** An engagement rate such as `4.2%`; calculated values are labeled where they're shown. */
export function rateLabel(rate: Calculated): string {
  return rate.value === null ? 'unknown' : `${(rate.value * 100).toFixed(1)}%`;
}

/** A net count with its sign, or `unknown`. */
export function netLabel(net: Calculated): string {
  if (net.value === null) return 'unknown';
  return net.value > 0
    ? `+${net.value.toLocaleString('en-US')}`
    : net.value.toLocaleString('en-US');
}

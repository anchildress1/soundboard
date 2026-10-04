import { error } from '@sveltejs/kit';
import {
  BRAND_THUMBNAILS,
  BRAND_VIDEOS,
  guideError,
  RULE_MAX,
  RULES_MAX,
  STATEMENT_MAX,
  type BrandGuide,
  type StoredBrand,
} from '$lib/brand';
import type { Wait } from '$lib/types';
import { ActionError } from './actions';
import type { Session } from './auth';
import { db } from './clients';
import { ARTIST_ID } from './memory';
import { chatJson, modelStatus, stepDeadline } from './model';
import { stripDeep } from './numerics';
import { isString, isStrings, shape } from './shape';
import { agentInput, agentOutput, invokeAgent, type ChatMessage } from './tracing';
import { recentVideos, thumbnailDataUrl, type CatalogVideo } from './youtube';

const DESCRIPTION_CHARS = 200;

const stringArray = { type: 'array', items: { type: 'string' } };

export const BRAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['statement', 'keep', 'fix', 'drop'],
  properties: {
    statement: { type: 'string' },
    keep: stringArray,
    fix: stringArray,
    drop: stringArray,
  },
} as const;

const BRAND_GUIDE = shape({
  statement: isString,
  keep: isStrings,
  fix: isStrings,
  drop: isStrings,
});

export function isBrandGuide(value: unknown): value is BrandGuide {
  return BRAND_GUIDE(value);
}

const RULES = [
  'Read the channel uploads below and describe what makes them recognizable as one channel.',
  'statement: two or three plain sentences on the observable patterns: title format, description structure, recurring lines, visual style of thumbnails.',
  'keep: patterns that are consistent and worth keeping.',
  'fix: patterns that are inconsistent or weak and how to make them consistent.',
  'drop: patterns that hurt discoverability or clarity and should stop.',
  `At most ${RULES_MAX} short rules per list. Base every rule on the uploads; do not invent facts.`,
].join('\n');

export function buildBrandMessages(
  videos: (CatalogVideo & { thumbnail: string | null })[],
): ChatMessage[] {
  const uploads = videos.map((v) => ({
    title: v.title,
    description: v.description.slice(0, DESCRIPTION_CHARS),
    tags: v.tags,
    publishedAt: v.publishedAt,
  }));
  const thumbnails = videos
    .map((v) => v.thumbnail)
    .filter((t): t is string => Boolean(t))
    .map((url) => ({ type: 'image_url' as const, image_url: { url } }));
  return [
    { role: 'system', content: RULES },
    {
      role: 'user',
      content: [
        { type: 'text', text: JSON.stringify({ uploads }) },
        ...(thumbnails.length > 0
          ? [{ type: 'text' as const, text: 'Thumbnails of the newest uploads:' }, ...thumbnails]
          : []),
      ],
    },
  ];
}

const clip = (text: string, max: number) => text.trim().slice(0, max).trim();

function cleanRules(rules: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rule of rules.map((r) => clip(r, RULE_MAX)).filter(Boolean)) {
    const key = rule.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out.slice(0, RULES_MAX);
}

/** Trims, caps, and dedupes a guide, and strips any audio figures the model emits. */
export function cleanGuide(raw: BrandGuide): BrandGuide {
  const guide = stripDeep(raw);
  return {
    statement: clip(guide.statement, STATEMENT_MAX),
    keep: cleanRules(guide.keep),
    fix: cleanRules(guide.fix),
    drop: cleanRules(guide.drop),
  };
}

/** The brand guide is Nathan's: anyone else gets the same 404 as a missing page. */
export function requireAllowlisted(session: Session | null): void {
  if (!session?.allowlisted) error(404, 'Not found');
}

const brand = () => db().collection('artists').doc(ARTIST_ID).collection('brand');

async function read(id: 'approved' | 'proposal'): Promise<StoredBrand | null> {
  const snap = await brand().doc(id).get();
  return snap.exists ? (snap.data() as StoredBrand) : null;
}

/** Allowlisted callers only: the approved guide and any pending proposal. */
export async function getBrand(): Promise<{
  approved: StoredBrand | null;
  proposal: StoredBrand | null;
}> {
  const [approved, proposal] = await Promise.all([read('approved'), read('proposal')]);
  return { approved, proposal };
}

/** The approved guide as smart pick consumes it, or null before Nathan approves one. */
export async function approvedBrand(): Promise<BrandGuide | null> {
  const approved = await read('approved');
  if (!approved) return null;
  const { statement, keep, fix, drop } = approved;
  return { statement, keep, fix, drop };
}

/**
 * Proposes a guide from the latest uploads. A loading or busy model returns a wait at once, as
 * pipeline steps do; the page calls again.
 */
export async function proposeBrand(): Promise<{ wait: Wait } | { proposal: StoredBrand }> {
  const deadline = stepDeadline();
  const status = await modelStatus();
  if (status === 'loading') return { wait: 'waking model' };
  if (status === 'busy') return { wait: 'waiting on another run' };

  const videos = await recentVideos(BRAND_VIDEOS, null);
  if (videos.length === 0)
    throw new ActionError(409, 'The channel has no public uploads to learn from.');
  const withThumbs = await Promise.all(
    videos.map(async (v, i) => ({
      ...v,
      thumbnail:
        i < BRAND_THUMBNAILS && v.thumbnailUrl ? await thumbnailDataUrl(v.thumbnailUrl) : null,
    })),
  );

  const guide = await invokeAgent('brand-guide', async (span) => {
    span.setAttribute('brand.video_count', videos.length);
    const messages = buildBrandMessages(withThumbs);
    agentInput(span, messages);
    const { value } = await chatJson(messages, 'brand_guide', BRAND_SCHEMA, isBrandGuide, deadline);
    if (!value) return null;
    const cleaned = cleanGuide(value);
    agentOutput(span, JSON.stringify(cleaned));
    return cleaned;
  });
  if (!guide)
    throw new ActionError(502, 'The model reply did not parse as a brand guide. Try again.');

  const proposal: StoredBrand = {
    ...guide,
    status: 'PROPOSED',
    basedOn: videos.map((v) => v.videoId),
    createdAt: Date.now(),
    approvedAt: null,
  };
  await brand().doc('proposal').set(proposal);
  return { proposal };
}

/**
 * Approves the guide as edited, replacing any earlier one. The proposal is re-read in the same
 * transaction and must be the one under review (`proposedAt` is its `createdAt`), so a discard or
 * a newer proposal from another tab can't be approved with stale text.
 */
export async function approveBrand(input: unknown): Promise<StoredBrand> {
  if (!isBrandGuide(input))
    throw new ActionError(400, 'Expected a statement and keep, fix, drop lists.');
  const { proposedAt } = input as { proposedAt?: unknown };
  if (typeof proposedAt !== 'number')
    throw new ActionError(400, 'Name the proposal being approved.');
  const trim = (rules: string[]) => rules.map((r) => r.trim()).filter(Boolean);
  const guide: BrandGuide = {
    statement: input.statement.trim(),
    keep: trim(input.keep),
    fix: trim(input.fix),
    drop: trim(input.drop),
  };
  const problem = guideError(guide);
  if (problem) throw new ActionError(422, problem);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(brand().doc('proposal'));
    if (!snap.exists) throw new ActionError(409, 'There is no proposal to approve.');
    const proposal = snap.data() as StoredBrand;
    if (proposal.createdAt !== proposedAt) {
      throw new ActionError(409, 'A newer proposal replaced this one. Reload to review it.');
    }
    const approved: StoredBrand = {
      ...guide,
      status: 'APPROVED',
      basedOn: proposal.basedOn,
      createdAt: proposal.createdAt,
      approvedAt: Date.now(),
    };
    tx.set(brand().doc('approved'), approved);
    tx.delete(brand().doc('proposal'));
    return approved;
  });
}

/** Drops the pending proposal; the approved guide, if any, stays. */
export async function discardBrandProposal(): Promise<void> {
  await brand().doc('proposal').delete();
}

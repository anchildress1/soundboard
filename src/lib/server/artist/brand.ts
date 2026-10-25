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
import { ActionError } from '$lib/server/core/errors';
import { required } from '$lib/server/core/env';
import { and, eq } from 'drizzle-orm';
import { query, type Tx } from '$lib/server/core/db';
import { artistMemory } from '$lib/server/core/schema';
import { ARTIST_ID, memoryOf } from './memory';
import { chatJson, ModelBusy, modelFor, ModelQuotaSpent, stepDeadline } from '$lib/server/ai/model';
import { stripDeep } from '$lib/server/ai/numerics';
import { isString, isStrings, shape } from '$lib/server/ai/shape';
import {
  agentInput,
  agentOutput,
  invokeAgent,
  type ModelRequest,
  type Part,
} from '$lib/server/core/tracing';
import {
  recentVideos,
  thumbnailImage,
  type CatalogVideo,
  type Thumbnail,
} from '$lib/server/platforms/youtube';

const DESCRIPTION_CHARS = 200;
/** Uploads carry 14 to 44 tags each; the leading few show the pattern without paying for the rest. */
const TAGS_PER_VIDEO = 8;
/** A count cap alone still lets long tags through, so the text is capped too. */
const TAG_CHARS = 120;

/** The upload's first tags, at most 8 and 120 characters together. */
function leadingTags(tags: string[]): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (const tag of tags.slice(0, TAGS_PER_VIDEO)) {
    chars += tag.length;
    if (chars > TAG_CHARS) break;
    kept.push(tag);
  }
  return kept;
}

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

export function buildBrandRequest(
  videos: (CatalogVideo & { thumbnail: Thumbnail | null })[],
): ModelRequest {
  const uploads = videos.map((v) => ({
    title: v.title,
    description: v.description.slice(0, DESCRIPTION_CHARS),
    tags: leadingTags(v.tags),
    publishedAt: v.publishedAt,
  }));
  const thumbnails = videos.flatMap((v): Part[] =>
    v.thumbnail ? [{ type: 'image', ...v.thumbnail }] : [],
  );
  return {
    system: RULES,
    turns: [
      {
        role: 'user',
        parts: [
          { type: 'text', text: JSON.stringify({ uploads }) },
          ...(thumbnails.length > 0
            ? [{ type: 'text' as const, text: 'Thumbnails of the newest uploads:' }, ...thumbnails]
            : []),
        ],
      },
    ],
  };
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

/** The brand guide is Nathan's: anyone not linked to his artist gets the same 404 as a missing page. */
export function requireArtist(user: { artistId: string | null } | null): void {
  if (user?.artistId !== ARTIST_ID) error(404, 'Not found');
}

type Slot = 'approved' | 'proposal';
const slot = (name: Slot) => and(memoryOf('brand'), eq(artistMemory.key, name));

async function read(name: Slot): Promise<StoredBrand | null> {
  const [row] = await query((tx) =>
    tx.select({ data: artistMemory.data }).from(artistMemory).where(slot(name)),
  );
  return (row?.data as StoredBrand | undefined) ?? null;
}

async function write(tx: Tx, name: Slot, data: StoredBrand): Promise<void> {
  await tx
    .insert(artistMemory)
    .values({ artistId: ARTIST_ID, kind: 'brand', key: name, data })
    .onConflictDoUpdate({
      target: [artistMemory.artistId, artistMemory.kind, artistMemory.key],
      set: { data },
    });
}

/** Linked callers only: the approved guide and any pending proposal. */
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
 * Proposes a guide from the latest uploads. A busy model or a spent quota returns its wait at once,
 * as pipeline steps do, and saves nothing; the page calls again on `model busy`.
 */
export async function proposeBrand(): Promise<{ wait: Wait } | { proposal: StoredBrand }> {
  const deadline = stepDeadline();

  const videos = await recentVideos(required('FLR_CHANNEL_ID'), BRAND_VIDEOS);
  if (videos.length === 0)
    throw new ActionError(409, 'The channel has no public uploads to learn from.');
  const withThumbs = await Promise.all(
    videos.map(async (v, i) => ({
      ...v,
      thumbnail:
        i < BRAND_THUMBNAILS && v.thumbnailUrl ? await thumbnailImage(v.thumbnailUrl) : null,
    })),
  );

  const guide = await invokeAgent('brand-guide', modelFor('brand-guide'), async (span) => {
    span.setAttribute('brand.video_count', videos.length);
    const request = buildBrandRequest(withThumbs);
    agentInput(span, request);
    const { value } = await chatJson(request, 'brand-guide', BRAND_SCHEMA, isBrandGuide, deadline);
    if (!value) return null;
    const cleaned = cleanGuide(value);
    agentOutput(span, JSON.stringify(cleaned));
    return cleaned;
  }).catch((error: unknown) => {
    if (error instanceof ModelBusy) return { wait: 'model busy' } as const;
    if (error instanceof ModelQuotaSpent) return { wait: 'model quota spent' } as const;
    throw error;
  });
  if (guide && 'wait' in guide) return guide;
  if (!guide)
    throw new ActionError(502, 'The model reply did not parse as a brand guide. Try again.');

  const proposal: StoredBrand = {
    ...guide,
    status: 'PROPOSED',
    basedOn: videos.map((v) => v.videoId),
    createdAt: Date.now(),
    approvedAt: null,
  };
  await query((tx) => write(tx, 'proposal', proposal));
  return { proposal };
}

const trimRules = (rules: string[]) => rules.map((r) => r.trim()).filter(Boolean);

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
  const guide: BrandGuide = {
    statement: input.statement.trim(),
    keep: trimRules(input.keep),
    fix: trimRules(input.fix),
    drop: trimRules(input.drop),
  };
  const problem = guideError(guide);
  if (problem) throw new ActionError(422, problem);
  return await query(async (tx) => {
    const [row] = await tx
      .select({ data: artistMemory.data })
      .from(artistMemory)
      .where(slot('proposal'))
      .for('update');
    if (!row) throw new ActionError(409, 'There is no proposal to approve.');
    const proposal = row.data as StoredBrand;
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
    await write(tx, 'approved', approved);
    await tx.delete(artistMemory).where(slot('proposal'));
    return approved;
  });
}

/** Drops the pending proposal; the approved guide, if any, stays. */
export async function discardBrandProposal(): Promise<void> {
  await query((tx) => tx.delete(artistMemory).where(slot('proposal')));
}

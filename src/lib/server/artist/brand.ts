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
} from '#lib/brand.js';
import type { Wait } from '#lib/types.js';
import { ActionError } from '#lib/server/core/errors.js';
import { and, eq } from 'drizzle-orm';
import { query, type Tx } from '#lib/server/core/db.js';
import { artistMemory } from '#lib/server/core/schema.js';
import { memoryOf } from './memory';
import type { ArtistProfile } from './profile';
import {
  chatJson,
  hasModelTime,
  ModelBusy,
  modelFor,
  ModelQuotaSpent,
  stepDeadline,
} from '#lib/server/ai/model.js';
import { stripDeep } from '#lib/server/ai/numerics.js';
import { isString, isStrings, shape } from '#lib/server/ai/shape.js';
import {
  agentInput,
  agentOutput,
  imageParts,
  invokeAgent,
  youtubePart,
  type ModelRequest,
} from '#lib/server/core/tracing.js';
import {
  ownChannelUploads,
  thumbnailImage,
  type CatalogVideo,
  type Thumbnail,
} from '#lib/server/platforms/youtube/index.js';

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
  return {
    system: RULES,
    turns: [
      {
        role: 'user',
        parts: [
          // Tagged so spans record a placeholder, never the uploads' text (research R13).
          youtubePart({ uploads }, uploads.length),
          ...imageParts(
            'Thumbnails of the newest uploads:',
            videos.map((v) => v.thumbnail),
          ),
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

/**
 * The brand guide is only for the curated profile until spec 005; everyone else gets the same 404
 * as a missing page. Returns the curated profile's ID.
 */
export function requireCurated(user: { artist: ArtistProfile | null } | null): string {
  if (!user?.artist?.curated) error(404, 'Not found');
  return user.artist.id;
}

type Slot = 'approved' | 'proposal';
const slot = (artistId: string, name: Slot) =>
  and(memoryOf(artistId, 'brand'), eq(artistMemory.key, name));

async function read(artistId: string, name: Slot): Promise<StoredBrand | null> {
  const [row] = await query((tx) =>
    tx.select({ data: artistMemory.data }).from(artistMemory).where(slot(artistId, name)),
  );
  return (row?.data as StoredBrand | undefined) ?? null;
}

async function write(tx: Tx, artistId: string, name: Slot, data: StoredBrand): Promise<void> {
  await tx
    .insert(artistMemory)
    .values({ artistId, kind: 'brand', key: name, data })
    .onConflictDoUpdate({
      target: [artistMemory.artistId, artistMemory.kind, artistMemory.key],
      set: { data },
    });
}

/** The artist's approved guide and any pending proposal. */
export async function getBrand(artistId: string): Promise<{
  approved: StoredBrand | null;
  proposal: StoredBrand | null;
}> {
  const [approved, proposal] = await Promise.all([
    read(artistId, 'approved'),
    read(artistId, 'proposal'),
  ]);
  return { approved, proposal };
}

/** The approved guide as smart pick consumes it, or null before the artist approves one. */
export async function approvedBrand(artistId: string): Promise<BrandGuide | null> {
  const approved = await read(artistId, 'approved');
  if (!approved) return null;
  const { statement, keep, fix, drop } = approved;
  return { statement, keep, fix, drop };
}

/**
 * Proposes a guide from the owner's latest uploads, read on their own grant. A lost grant, a busy
 * YouTube, a busy model or a spent quota returns its wait at once, as pipeline steps do, and saves
 * nothing; the page calls again on `model busy` and `waiting on YouTube`.
 */
export async function proposeBrand(
  uid: string,
  artistId: string,
): Promise<{ wait: Wait } | { proposal: StoredBrand }> {
  const deadline = stepDeadline();

  const videos = await ownChannelUploads(uid, BRAND_VIDEOS, deadline);
  if (!Array.isArray(videos)) return videos;
  if (videos.length === 0)
    throw new ActionError(409, 'The channel has no public uploads to learn from.');
  const withThumbs = await Promise.all(
    videos.map(async (v, i) => ({
      ...v,
      thumbnail:
        i < BRAND_THUMBNAILS && v.thumbnailUrl
          ? await thumbnailImage(v.thumbnailUrl, deadline)
          : null,
    })),
  );
  if (!hasModelTime('brand-guide', deadline)) return { wait: 'model busy' };

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
    // A count only: video IDs and text from YouTube are never stored (research R13).
    uploadCount: videos.length,
    createdAt: Date.now(),
    approvedAt: null,
  };
  await query((tx) => write(tx, artistId, 'proposal', proposal));
  return { proposal };
}

const trimRules = (rules: string[]) => rules.map((r) => r.trim()).filter(Boolean);

/**
 * Approves the guide as edited, replacing any earlier one. The proposal is re-read in the same
 * transaction and must be the one under review (`proposedAt` is its `createdAt`), so a discard or
 * a newer proposal from another tab can't be approved with stale text.
 */
export async function approveBrand(artistId: string, input: unknown): Promise<StoredBrand> {
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
      .where(slot(artistId, 'proposal'))
      .for('update');
    if (!row) throw new ActionError(409, 'There is no proposal to approve.');
    const proposal = row.data as StoredBrand;
    if (proposal.createdAt !== proposedAt) {
      throw new ActionError(409, 'A newer proposal replaced this one. Reload to review it.');
    }
    const approved: StoredBrand = {
      ...guide,
      status: 'APPROVED',
      uploadCount: proposal.uploadCount,
      createdAt: proposal.createdAt,
      approvedAt: Date.now(),
    };
    await write(tx, artistId, 'approved', approved);
    await tx.delete(artistMemory).where(slot(artistId, 'proposal'));
    return approved;
  });
}

/** Drops the pending proposal; the approved guide, if any, stays. */
export async function discardBrandProposal(artistId: string): Promise<void> {
  await query((tx) => tx.delete(artistMemory).where(slot(artistId, 'proposal')));
}

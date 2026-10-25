import {
  BRAND_THUMBNAILS,
  BRAND_VIDEOS,
  RULE_MAX,
  RULES_MAX,
  STATEMENT_MAX,
  type BrandGuide,
} from '#lib/brand.js';
import { ActionError } from '#lib/server/core/errors.js';
import { proposeStep, type ProposeResult } from './guides';
import { chatJson, hasModelTime, modelFor } from '#lib/server/ai/model.js';
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

/** Trims, clips to `length`, dedupes ignoring case, and keeps the first `count` rules. */
export function cleanRules(rules: string[], length = RULE_MAX, count = RULES_MAX): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rule of rules.map((r) => clip(r, length)).filter(Boolean)) {
    const key = rule.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out.slice(0, count);
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
 * Proposes a guide from the owner's latest uploads, read on their own grant, as one claimed step.
 * A lost or missing grant, a busy YouTube, a busy model or a spent quota returns its wait at once
 * and saves nothing; the page calls again on `model busy` and `waiting on YouTube`.
 */
export async function proposeBrand(user: {
  uid: string;
  artistId: string;
}): Promise<ProposeResult<BrandGuide>> {
  return await proposeStep(user.artistId, 'brand', async (deadline) => {
    const videos = await ownChannelUploads(user.uid, BRAND_VIDEOS, deadline, {
      'guide.kind': 'brand',
    });
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
      const { value } = await chatJson(
        request,
        'brand-guide',
        BRAND_SCHEMA,
        isBrandGuide,
        deadline,
      );
      if (!value) return null;
      const cleaned = cleanGuide(value);
      agentOutput(span, JSON.stringify(cleaned), 'brand-guide');
      return cleaned;
    });
    if (!guide)
      throw new ActionError(502, 'The model reply did not parse as a brand guide. Try again.');
    return {
      body: guide,
      sources: {
        uploads: videos.map(({ videoId, title, publishedAt }) => ({ videoId, title, publishedAt })),
        drafts: [],
        edits: 0,
        approvals: 0,
        thin: false,
      },
    };
  });
}

const trimRules = (rules: string[]) => rules.map((r) => r.trim()).filter(Boolean);

/** The edited guide from an approve body, trimmed; a wrong shape is a 400. */
export function brandInput(input: unknown): BrandGuide {
  if (!isBrandGuide(input))
    throw new ActionError(400, 'Expected a statement and keep, fix, drop lists.');
  return {
    statement: input.statement.trim(),
    keep: trimRules(input.keep),
    fix: trimRules(input.fix),
    drop: trimRules(input.drop),
  };
}

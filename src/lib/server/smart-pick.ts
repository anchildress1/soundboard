import { DESCRIPTION_MAX, parseHashtags, tagsLength, TAGS_MAX, TITLE_MAX } from '$lib/metadata';
import type { Chunk, Measurements, Pick } from '$lib/types';
import { ARTIST_NAME, type Fact, type Feedback } from './memory';
import { chatJson, stepDeadline } from './model';
import { stripDeep } from './numerics';
import type { ChatMessage } from './tracing';
import type { CatalogVideo } from './youtube';

const stringArray = { type: 'array', items: { type: 'string' } };

export const PICK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'hashtags', 'tags', 'flags', 'brandCheck', 'why'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    hashtags: stringArray,
    tags: stringArray,
    flags: stringArray,
    brandCheck: { type: 'string' },
    why: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'description', 'tags'],
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'string' },
      },
    },
  },
} as const;

export type RawPick = Omit<Pick, 'version' | 'modelMs'>;

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

export function isRawPick(value: unknown): value is RawPick {
  const v = value as RawPick | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.title === 'string' &&
    typeof v.description === 'string' &&
    isStrings(v.hashtags) &&
    isStrings(v.tags) &&
    isStrings(v.flags) &&
    typeof v.brandCheck === 'string' &&
    typeof v.why === 'object' &&
    v.why !== null &&
    typeof v.why.title === 'string' &&
    typeof v.why.description === 'string' &&
    typeof v.why.tags === 'string'
  );
}

export type PickContext = {
  songTitle: string;
  notes: string;
  /** False for signed-out own-video runs: the proposal must not carry the FLR name. */
  useArtistName: boolean;
  chunks: Chunk[];
  measurements: Measurements | null;
  recent: (CatalogVideo & { thumbnail: string | null })[];
  candidates: string[];
  facts: Fact[];
  feedback: Feedback[];
  skipped: { title: string; description: string }[];
};

const RECENT_DESCRIPTION_CHARS = 700;

/** Condenses the chunk results into what the pick needs, keeping the prompt inside the context window. */
export function digestChunks(chunks: Chunk[]) {
  return chunks.map((chunk) => ({
    at: Math.round(chunk.startSec),
    visual: chunk.analysis?.visual ?? undefined,
    genre: chunk.analysis?.music.genre,
    tempoFeel: chunk.analysis?.music.tempoFeel,
    instrumentation: chunk.analysis?.music.instrumentation,
    vocals: chunk.analysis?.music.vocals,
    mood: chunk.analysis?.music.mood,
    qualityFlags: chunk.analysis?.qualityFlags.length ? chunk.analysis.qualityFlags : undefined,
    unparsed: chunk.raw ? chunk.raw.slice(0, 300) : undefined,
  }));
}

/** Edits and approvals are strong signals; a re-run only means "not this one". */
export function weighFeedback(feedback: Feedback[]) {
  return feedback.map((f) => ({
    weight: f.kind === 'SKIPPED' ? 'weak' : 'strong',
    kind: f.kind,
    song: f.songTitle,
    field: f.field,
    before: f.before?.slice(0, 300),
    after: f.after?.slice(0, 300),
  }));
}

function skippedRule(ctx: PickContext): string {
  if (ctx.skipped.length === 0) return '';
  return ctx.useArtistName
    ? 'Do not repeat any skipped version; write a different title.'
    : 'Do not repeat any skipped version; write a different description and tags.';
}

export function buildPickMessages(ctx: PickContext): ChatMessage[] {
  const artist = ctx.useArtistName ? ARTIST_NAME : null;
  const rules = [
    'Write one YouTube upload recommendation for a new music video: title, description, hashtags, tags.',
    'Keep what already works in the recent uploads (naming pattern, tone, recurring lines); improve only what is weak.',
    `title: at most ${TITLE_MAX} characters.${artist ? '' : ' The title is set separately; name no artist anywhere.'}`,
    "description: plain text that follows the structure, length, and recurring lines of the recent uploads' descriptions; no hashtags inside it, they are appended separately. Only include links listed in facts.",
    'hashtags: pick 3 to 5, copied exactly from candidateHashtags. Never invent one.',
    `tags: plain search terms without #: genres, the song title${artist ? ', the artist name' : ''}. Under ${TAGS_MAX} characters combined.`,
    'flags: problems a viewer would notice, taken from the window analysis. No loudness, level, or tempo numbers.',
    'brandCheck: one sentence on how the proposal matches or departs from the recent uploads.',
    'why: one short reason per field for the choice made.',
    skippedRule(ctx),
  ].filter(Boolean);
  const context = {
    artist,
    songTitle: ctx.songTitle,
    artistNotes: ctx.notes || undefined,
    // Private facts never reach the model, so they can't surface in publishable copy.
    facts: ctx.facts
      .filter((fact) => fact.public)
      .map(({ key, value, kind, public: isPublic }) => ({
        key,
        value,
        kind,
        public: isPublic,
      })),
    windows: digestChunks(ctx.chunks),
    ffmpeg: ctx.measurements ?? undefined,
    recentUploads: ctx.recent.map((v) => ({
      title: v.title,
      description: v.description.slice(0, RECENT_DESCRIPTION_CHARS),
      tags: v.tags,
      publishedAt: v.publishedAt,
    })),
    candidateHashtags: ctx.candidates,
    feedback: weighFeedback(ctx.feedback),
    skippedVersions: ctx.skipped.length > 0 ? ctx.skipped : undefined,
  };
  const thumbnails = ctx.recent
    .map((v) => v.thumbnail)
    .filter((t): t is string => Boolean(t))
    .map((url) => ({ type: 'image_url' as const, image_url: { url } }));
  return [
    { role: 'system', content: rules.join('\n') },
    {
      role: 'user',
      content: [
        { type: 'text', text: JSON.stringify(context) },
        ...(thumbnails.length > 0
          ? [
              { type: 'text' as const, text: 'Thumbnails of the recent uploads, newest first:' },
              ...thumbnails,
            ]
          : []),
      ],
    },
  ];
}

const URL_PATTERN = /https?:\/\/[^\s)]+/g;

/** Keeps only links that appear in public FACT or APPROVED records. */
export function allowedLinks(text: string, facts: Fact[]): string {
  const allowed = facts
    .filter((f) => f.public && f.kind !== 'INFERENCE')
    .flatMap((f) => f.value.match(URL_PATTERN) ?? []);
  return text.replaceAll(URL_PATTERN, (url) => (allowed.includes(url) ? url : ''));
}

const ARTIST_PATTERN = /\b(?:flies like robots|flr)\b/giu;
const ARTIST_HASHTAG = /^#(?:flieslikerobots|flr)/i;
const SEPARATORS = new Set(['-', '–', '|', '·']);
const CUT = '\u0000';

function removeArtistFromLine(line: string): string {
  const tokens = line
    .replaceAll(/[ \t]+/g, ' ')
    .replaceAll(ARTIST_PATTERN, ` ${CUT} `)
    .split(' ');
  const out: string[] = [];
  let afterCut = false;
  for (const token of tokens) {
    if (!token) continue;
    if (token === CUT) {
      if (SEPARATORS.has(out.at(-1) ?? '')) out.pop();
      afterCut = true;
      continue;
    }
    if (afterCut && SEPARATORS.has(token)) continue;
    afterCut = false;
    out.push(token);
  }
  while (SEPARATORS.has(out[0] ?? '')) out.shift();
  while (SEPARATORS.has(out.at(-1) ?? '')) out.pop();
  return out.join(' ').replaceAll(/ ([,.;:!?)])/g, '$1');
}

/** Drops the artist name with the separator next to it, so "Song - Flies Like Robots" leaves "Song". */
const removeArtist = (text: string) => text.split('\n').map(removeArtistFromLine).join('\n');

const BODY_HASHTAG = /(?<!\S)#[\p{L}\p{N}_]+/gu;

const tidy = (text: string) =>
  text
    .replaceAll(/[<>]/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .replaceAll(/[ \t]{2,}/g, ' ')
    .trim();

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

const VISITOR_SUFFIX = ' (Official Video)';

/** Signed-out own-video payloads carry a fixed title: the song, then "(Official Video)" (R8). */
export function visitorTitle(songTitle: string): string {
  return `${clip(tidy(songTitle), TITLE_MAX - VISITOR_SUFFIX.length)}${VISITOR_SUFFIX}`;
}

export type PickFixups = {
  songTitle: string;
  candidates: string[];
  facts: Fact[];
  useArtistName: boolean;
  measurements: Measurements | null;
};

/** Measured problems, phrased from ffmpeg's numbers. */
export function measuredFlags(m: Measurements | null): string[] {
  if (!m) return [];
  const flags: string[] = [];
  if (m.truePeakDbtp !== null && m.truePeakDbtp > -1) {
    flags.push(`True peak ${m.truePeakDbtp.toFixed(1)} dBTP, above the -1 dBTP ceiling`);
  }
  if (m.clippedSamples > 0) flags.push(`${m.clippedSamples} samples at full scale (clipping)`);
  for (const s of m.silences.filter((s) => s.end - s.start >= 2)) {
    flags.push(`Silence ${s.start.toFixed(1)}s to ${s.end.toFixed(1)}s`);
  }
  return flags;
}

/** 3 to 5 hashtags from the pool: the model's picks first, padded from the top of the pool. */
function pickHashtags(draft: RawPick, pool: string[]): string[] {
  const byLower = new Map(pool.map((c) => [c.toLowerCase(), c]));
  const picked = [
    ...new Set(
      [...draft.hashtags, ...parseHashtags(draft.description)].map((t) =>
        (t.startsWith('#') ? t : `#${t}`).toLowerCase(),
      ),
    ),
  ]
    .filter((t) => byLower.has(t))
    .slice(0, 5);
  for (const candidate of pool) {
    if (picked.length >= 3) break;
    if (!picked.includes(candidate.toLowerCase())) picked.push(candidate.toLowerCase());
  }
  return picked.map((t) => byLower.get(t)!);
}

/** Plain-term tags: no leading #, deduped, within YouTube's 500-character total. */
function cleanTags(raw: string[], scrub: (text: string) => string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const tag of raw.map((t) => tidy(scrub(t.replace(/^#+/, '')))).filter(Boolean)) {
    const key = tag.toLowerCase();
    if (seen.has(key) || tagsLength([...tags, tag]) > TAGS_MAX) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/**
 * Enforces R4 on the model's draft: hashtags only from candidates (3–5, closing the description),
 * links only from facts, plain-term tags, YouTube limits, and no model-emitted audio numbers.
 */
export function finalizePick(raw: RawPick, fix: PickFixups): RawPick {
  const draft = stripDeep(raw);
  // Signed-out own-video payloads must not name the artist, hashtags included.
  const pool = fix.useArtistName
    ? fix.candidates
    : fix.candidates.filter((c) => !ARTIST_HASHTAG.test(c));
  const hashtags = pickHashtags(draft, pool);

  const scrub = fix.useArtistName ? (t: string) => t : removeArtist;
  // tidy() runs first so `#<word>` can't turn into a hashtag after the brackets go.
  let body = tidy(
    tidy(scrub(allowedLinks(draft.description, fix.facts))).replaceAll(BODY_HASHTAG, ''),
  );
  const closing = hashtags.join(' ');
  body = clip(body, DESCRIPTION_MAX - closing.length - 2);
  const description = closing ? `${body}\n\n${closing}`.trim() : body;

  const tags = cleanTags(draft.tags, scrub);

  return {
    title: fix.useArtistName ? clip(tidy(draft.title), TITLE_MAX) : visitorTitle(fix.songTitle),
    description,
    hashtags,
    tags,
    flags: [...measuredFlags(fix.measurements), ...draft.flags.map(scrub).filter(Boolean)],
    brandCheck: scrub(draft.brandCheck),
    why: {
      title: scrub(draft.why.title),
      description: scrub(draft.why.description),
      tags: scrub(draft.why.tags),
    },
  };
}

export const sameTitle = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Runs the pick, retrying once when the title repeats a skipped version. Returns null when the
 * model's reply never parses.
 */
export async function runPick(
  ctx: PickContext,
  deadline = stepDeadline(),
): Promise<{ pick: RawPick; ms: number } | null> {
  let ms = 0;
  let messages = buildPickMessages(ctx);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { value, ms: took } = await chatJson(
      messages,
      'smart_pick',
      PICK_SCHEMA,
      isRawPick,
      deadline,
    );
    ms += took;
    if (!value) return null;
    const pick = finalizePick(value, ctx);
    // A fixed visitor title can't change, so only model-written titles must differ on a re-run.
    const repeats = ctx.useArtistName && ctx.skipped.some((s) => sameTitle(s.title, pick.title));
    if (!repeats) return { pick, ms };
    // A re-run must produce a new title; a second repeat fails the pick so the step retries.
    if (attempt === 1) return null;
    messages = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(value) },
      { role: 'user', content: `"${pick.title}" was already skipped. Write a different title.` },
    ];
  }
  return null;
}

import { DESCRIPTION_MAX, parseHashtags, tagsLength, TAGS_MAX, TITLE_MAX } from '$lib/metadata';
import type { Chunk, Measurements, Pick } from '$lib/types';
import { ARTIST_NAME, type Fact, type Feedback } from './memory';
import { chatJson } from './model';
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

export function buildPickMessages(ctx: PickContext): ChatMessage[] {
  const artist = ctx.useArtistName ? ARTIST_NAME : null;
  const rules = [
    'Write one YouTube upload recommendation for a new music video: title, description, hashtags, tags.',
    'Keep what already works in the recent uploads (naming pattern, tone, recurring lines); improve only what is weak.',
    `title: at most ${TITLE_MAX} characters.${artist ? '' : ' Use the song title only; name no artist.'}`,
    "description: plain text in the channel's voice, no hashtags inside it; they are appended separately. Only include links listed in facts.",
    'hashtags: pick 3 to 5, copied exactly from candidateHashtags. Never invent one.',
    `tags: plain search terms without #: genres, the song title${artist ? ', the artist name' : ''}. Under ${TAGS_MAX} characters combined.`,
    'flags: problems a viewer would notice, taken from the window analysis. No loudness, level, or tempo numbers.',
    'brandCheck: one sentence on how the proposal matches or departs from the recent uploads.',
    'why: one short reason per field for the choice made.',
    'Never mention facts marked public: false.',
    ctx.skipped.length > 0 ? 'Do not repeat any skipped version; write a different title.' : '',
  ].filter(Boolean);
  const context = {
    artist,
    songTitle: ctx.songTitle,
    artistNotes: ctx.notes || undefined,
    facts: ctx.facts.map(({ key, value, kind, public: isPublic }) => ({
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

/** Keeps only links that appear in FACT or APPROVED records. */
export function allowedLinks(text: string, facts: Fact[]): string {
  const allowed = facts
    .filter((f) => f.kind !== 'INFERENCE')
    .flatMap((f) => f.value.match(URL_PATTERN) ?? []);
  return text.replace(URL_PATTERN, (url) => (allowed.includes(url) ? url : ''));
}

// The name goes with the separator next to it, so "Song - Flies Like Robots" leaves "Song".
const ARTIST_PATTERN = /\s*[-–|·]?\s*\b(?:flies\s+like\s+robots|flr)\b\s*/giu;
const removeArtist = (text: string) =>
  text
    .replace(ARTIST_PATTERN, ' ')
    .replace(/^\s*[-–|·]\s*|\s*[-–|·]\s*$/gu, '')
    .trim();

const BODY_HASHTAG = /(?<!\S)#[\p{L}\p{N}_]+/gu;

const tidy = (text: string) =>
  text
    .replace(/[<>]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

export type PickFixups = {
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

/**
 * Enforces R4 on the model's draft: hashtags only from candidates (3–5, closing the description),
 * links only from facts, plain-term tags, YouTube limits, and no model-emitted audio numbers.
 */
export function finalizePick(raw: RawPick, fix: PickFixups): RawPick {
  const draft = stripDeep(raw);
  const byLower = new Map(fix.candidates.map((c) => [c.toLowerCase(), c]));
  const picked = [
    ...new Set(
      [...draft.hashtags, ...parseHashtags(draft.description)].map((t) =>
        (t.startsWith('#') ? t : `#${t}`).toLowerCase(),
      ),
    ),
  ]
    .filter((t) => byLower.has(t))
    .slice(0, 5);
  for (const candidate of fix.candidates) {
    if (picked.length >= 3) break;
    if (!picked.includes(candidate.toLowerCase())) picked.push(candidate.toLowerCase());
  }
  const hashtags = picked.map((t) => byLower.get(t)!);

  const scrub = fix.useArtistName ? (t: string) => t : removeArtist;
  // tidy() runs first so `#<word>` can't turn into a hashtag after the brackets go.
  let body = tidy(
    tidy(scrub(allowedLinks(draft.description, fix.facts))).replace(BODY_HASHTAG, ''),
  );
  const closing = hashtags.join(' ');
  body = clip(body, DESCRIPTION_MAX - closing.length - 2);
  const description = closing ? `${body}\n\n${closing}`.trim() : body;

  const tags: string[] = [];
  const seen = new Set<string>();
  for (const tag of draft.tags.map((t) => tidy(scrub(t.replace(/^#+/, '')))).filter(Boolean)) {
    const key = tag.toLowerCase();
    if (seen.has(key) || tagsLength([...tags, tag]) > TAGS_MAX) continue;
    seen.add(key);
    tags.push(tag);
  }

  return {
    title: clip(tidy(scrub(draft.title)), TITLE_MAX),
    description,
    hashtags,
    tags,
    flags: [...measuredFlags(fix.measurements), ...draft.flags.filter(Boolean)],
    brandCheck: draft.brandCheck,
    why: draft.why,
  };
}

export const sameTitle = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Runs the pick, retrying once when the title repeats a skipped version. Returns null when the
 * model's reply never parses.
 */
export async function runPick(ctx: PickContext): Promise<{ pick: RawPick; ms: number } | null> {
  let ms = 0;
  let messages = buildPickMessages(ctx);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { value, ms: took } = await chatJson(messages, 'smart_pick', PICK_SCHEMA, isRawPick);
    ms += took;
    if (!value) return null;
    const pick = finalizePick(value, ctx);
    const repeats = ctx.skipped.some((s) => sameTitle(s.title, pick.title));
    if (!repeats || attempt === 1) {
      return {
        pick: repeats
          ? { ...pick, flags: [...pick.flags, 'Title repeats a skipped version'] }
          : pick,
        ms,
      };
    }
    messages = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(value) },
      { role: 'user', content: `"${pick.title}" was already skipped. Write a different title.` },
    ];
  }
  return null;
}

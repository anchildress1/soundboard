import type { BrandGuide } from '$lib/brand';
import { DESCRIPTION_MAX, parseHashtags, tagsLength, TAGS_MAX, TITLE_MAX } from '$lib/metadata';
import type { Chunk, Measurements, Pick } from '$lib/types';
import { ARTIST_NAME, type Fact, type Feedback } from './memory';
import { chatJson, stepDeadline } from './model';
import { stripDeep } from './numerics';
import type { AudienceVideo, TagCandidate } from './hashtags';
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
  chunks: Chunk[];
  measurements: Measurements | null;
  recent: (CatalogVideo & { thumbnail: string | null })[];
  /** Hashtag candidates from the genre search (R4). */
  candidates: string[];
  /** Tag candidates from the genre search's results. */
  tagCandidates: TagCandidate[];
  /** The genre search's most-viewed results: the evidence for what reaches listeners. */
  audience: AudienceVideo[];
  facts: Fact[];
  feedback: Feedback[];
  skipped: { title: string; description: string }[];
  /** Nathan's approved guide (R12); null for visitor jobs and before he approves one. */
  brand: BrandGuide | null;
};

const RECENT_DESCRIPTION_CHARS = 700;

/**
 * How the artist writes, distilled from his own YouTube descriptions and comments (2024 on).
 * Applies to the description on runs that may name him; the audience evidence still sets its
 * structure and length.
 */
export const ARTIST_VOICE = [
  'Write the description the way the artist writes his own:',
  '- Short, plain, literal. Open with "<song> by Flies Like Robots".',
  '- At most one sentence about the song, said straight ("The lyrics are based on the premise that ...").',
  '- His credit line in his own wording, like "Written, performed, recorded, hacked and slashed by", with the credited name exactly as in recentUploads.',
  '- Album placement as a plain statement ("<song> is track 3 on the album <album>.") only when notes or facts give it.',
  '- Keep his contact line from recentUploads.',
  '- Dry, self-mocking humor: offhand labels for the video, or doubt about the genre said out loud, about this song.',
  '- At most one aside like "hehe" or "Har! Har!", inside a sentence, never on its own line. At most one word in caps.',
  '- Quoted phrases here show his style. Never copy them word for word, except the credit line.',
  '- No marketing copy: no "explores", "journey", "sonic", "soundscape", "for fans of", no calls to like or subscribe, no emoji.',
].join('\n');

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

/** Tags the pick may use: the genre search's tags plus the artist name. */
export function tagPool(fix: { tagCandidates: TagCandidate[] }): TagCandidate[] {
  return [...fix.tagCandidates, { tag: ARTIST_NAME, usedBy: 0 }];
}

export function buildPickMessages(ctx: PickContext): ChatMessage[] {
  const rules = [
    'Write one YouTube upload recommendation for a new music video: title, description, hashtags, tags.',
    "audienceTopVideos are the most-viewed music videos in this genre, ranked by views. They are the evidence for what reaches listeners: model the title format and the description's structure and length on them.",
    "recentUploads are the artist's own uploads. Use them only for identity: credit lines and how the artist is named. Do not copy their structure, tags, or hashtags.",
    `title: at most ${TITLE_MAX} characters.`,
    `description: plain text whose structure and length follow the audienceTopVideos descriptions; its wording follows the artist voice below. No hashtags inside it, they are appended separately. Only include links listed in facts.`,
    ARTIST_VOICE,
    'hashtags: pick 3 to 5, copied exactly from candidateHashtags. Never invent one.',
    `tags: pick 5 to ${MAX_TAGS}, each copied exactly from a candidateTags tag. usedBy is how many of the genre's top videos use it. Every tag must name something the windows heard: a genre, subgenre, style, or instrument a listener would search for. Skip mood, scene, and decade words (like neon, night city, 90s) unless the windows name them. Fewer strong tags beat many weak ones. Include "${ARTIST_NAME}". Never the song title. Never invent one.`,
    'flags: problems a viewer would notice, taken from the window analysis. No loudness, level, or tempo numbers.',
    ctx.brand
      ? "brandGuide is the artist's approved brand guide: follow keep, apply fix, avoid drop. It outranks patterns in the recent uploads."
      : '',
    `brandCheck: one sentence on how the proposal matches or departs from ${ctx.brand ? 'the brand guide' : 'the recent uploads'}.`,
    'why: one short reason per field naming its evidence: which audienceTopVideos or candidates it follows.',
    ctx.skipped.length > 0 ? 'Do not repeat any skipped version; write a different title.' : '',
  ].filter(Boolean);
  const context = {
    artist: ARTIST_NAME,
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
      publishedAt: v.publishedAt,
    })),
    audienceTopVideos: ctx.audience,
    brandGuide: ctx.brand ?? undefined,
    candidateHashtags: ctx.candidates,
    candidateTags: tagPool(ctx),
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

export type PickFixups = {
  songTitle: string;
  candidates: string[];
  tagCandidates: TagCandidate[];
  facts: Fact[];
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

const MIN_TAGS = 3;
const MAX_TAGS = 10;

/**
 * Tags only from the pool, never containing the song title: the model's picks first (at most 10),
 * padded to 3 from the top of the pool, within YouTube's 500-character total.
 */
function pickTags(raw: string[], pool: string[], songTitle: string): string[] {
  const byLower = new Map(pool.map((t) => [t.toLowerCase(), t]));
  const title = songTitle.trim().toLowerCase();
  const allowed = (key: string) => byLower.has(key) && !(title && key.includes(title));
  const keys = [...new Set(raw.map((t) => tidy(t.replace(/^#+/, '')).toLowerCase()))]
    .filter(allowed)
    .slice(0, MAX_TAGS);
  for (const candidate of pool) {
    if (keys.length >= MIN_TAGS) break;
    const key = candidate.toLowerCase();
    if (allowed(key) && !keys.includes(key)) keys.push(key);
  }
  const tags: string[] = [];
  for (const tag of keys.map((key) => byLower.get(key)!)) {
    if (tagsLength([...tags, tag]) <= TAGS_MAX) tags.push(tag);
  }
  return tags;
}

/**
 * Enforces R4 on the model's draft: hashtags only from candidates (3–5, closing the description),
 * links only from facts, plain-term tags, YouTube limits, and no model-emitted audio numbers.
 */
export function finalizePick(raw: RawPick, fix: PickFixups): RawPick {
  const draft = stripDeep(raw);
  const hashtags = pickHashtags(draft, fix.candidates);

  // tidy() runs first so `#<word>` can't turn into a hashtag after the brackets go.
  let body = tidy(tidy(allowedLinks(draft.description, fix.facts)).replaceAll(BODY_HASHTAG, ''));
  const closing = hashtags.join(' ');
  body = clip(body, DESCRIPTION_MAX - closing.length - 2);
  const description = closing ? `${body}\n\n${closing}`.trim() : body;

  const tags = pickTags(
    draft.tags,
    tagPool(fix).map((c) => c.tag),
    fix.songTitle,
  );

  return {
    title: clip(tidy(draft.title), TITLE_MAX),
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
    const repeats = ctx.skipped.some((s) => sameTitle(s.title, pick.title));
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

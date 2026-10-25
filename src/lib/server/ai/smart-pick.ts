import pRetry from 'p-retry';
import type { BrandGuide } from '#lib/brand.js';
import {
  containsWords,
  DESCRIPTION_MAX,
  parseHashtags,
  TITLE_MAX,
  withArtistTag,
} from '#lib/metadata.js';
import type { Chunk, Measurements, Pick, Probe } from '#lib/types.js';
import { REASK_ONCE } from '#lib/retry.js';
import type { Fact, Feedback } from '#lib/server/artist/memory.js';
import { chatJson } from './model';
import { stripDeep } from './numerics';
import { isString, isStrings, shape } from './shape';
import type { AudienceVideo, CandidateList, TagCandidate } from '#lib/server/pipeline/hashtags.js';
import {
  agentInput,
  agentOutput,
  imageParts,
  textTurn,
  youtubePart,
  type AgentSpan,
  type ModelRequest,
} from '#lib/server/core/tracing.js';
import type { CatalogVideo, Thumbnail } from '#lib/server/platforms/youtube/index.js';

const stringArray = { type: 'array', items: { type: 'string' } };

export const PICK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'hashtags', 'tags', 'brandCheck', 'why', 'bandcamp'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    hashtags: stringArray,
    tags: stringArray,
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
    bandcamp: {
      type: 'object',
      additionalProperties: false,
      required: ['about', 'credits'],
      properties: {
        about: { type: 'string' },
        credits: { type: 'string' },
      },
    },
  },
} as const;

/** The model's reply. Flags are never the model's: `finalizePick` builds them from measured evidence. */
export type RawPick = Omit<Pick, 'version' | 'modelMs' | 'flags' | 'artistName'>;
export type FinalPick = Omit<Pick, 'version' | 'modelMs'>;

const RAW_PICK = shape({
  title: isString,
  description: isString,
  hashtags: isStrings,
  tags: isStrings,
  brandCheck: isString,
  why: shape({ title: isString, description: isString, tags: isString }),
  bandcamp: shape({ about: isString, credits: isString }),
});

export function isRawPick(value: unknown): value is RawPick {
  return RAW_PICK(value);
}

/** The job owner's profile as the pick uses it; `curated` selects Nathan's voice (spec 005 drops it). */
export type PickArtist = { name: string; contactLine: string | null; curated: boolean };

export type PickContext = {
  artist: PickArtist;
  songTitle: string;
  notes: string;
  chunks: Chunk[];
  measurements: Measurements | null;
  probe: Probe | null;
  recent: (CatalogVideo & { thumbnail: Thumbnail | null })[];
  /** Candidates remain labeled by their source video (R4). */
  candidateLists: CandidateList[];
  /** Genre search examples for metadata format, without causal performance claims. */
  audience: AudienceVideo[];
  facts: Fact[];
  feedback: Feedback[];
  skipped: { title: string; description: string }[];
  /** The curated artist's approved guide; null otherwise and before one is approved. */
  brand: BrandGuide | null;
};

const RECENT_DESCRIPTION_CHARS = 700;

/**
 * How the artist writes, distilled from his own YouTube descriptions and comments (2024 on).
 * Applies to the curated profile's description; the audience evidence still sets its structure and
 * length.
 */
export const ARTIST_VOICE = [
  'Write the description the way the artist writes his own:',
  '- Short, plain, literal.',
  '- At most one sentence about the song, said straight, from artistNotes or what the windows show. Never claim what the lyrics say.',
  '- Album placement as a plain statement ("<song> is track 3 on the album <album>.") only when notes or facts give it.',
  '- Never write placeholders, brackets, or notes about missing information.',
  '- Dry, self-mocking humor: offhand labels for the video, or doubt about the genre said out loud, about this song.',
  '- At most one aside like "hehe" or "Har! Har!", inside a sentence, never on its own line. At most one word in caps.',
  '- Quoted phrases here show his style. Never copy them word for word, except the credit line.',
  '- No marketing copy: no "explores", "journey", "sonic", "soundscape", "for fans of", no calls to like or subscribe, no emoji.',
].join('\n');

/**
 * `ARTIST_VOICE`'s plain-copy rules without his humor, asides and caps, for every profile that isn't
 * curated, until spec 005 learns each artist's voice.
 */
export const GENERIC_VOICE = [
  'Write the description in plain words:',
  '- Short, plain, literal.',
  '- At most one sentence about the song, said straight, from artistNotes or what the windows show. Never claim what the lyrics say.',
  '- Album placement as a plain statement ("<song> is track 3 on the album <album>.") only when notes or facts give it.',
  '- Never write placeholders, brackets, or notes about missing information.',
  '- No marketing copy: no "explores", "journey", "sonic", "soundscape", "for fans of", no calls to like or subscribe, no emoji.',
].join('\n');

/** The curated artist's credit line: his identity, so only on his own profile. */
export const CREDIT_LINE = [
  'In the description, also:',
  '- His credit line in his own wording, like "Written, performed, recorded, hacked and slashed by", with the credited name exactly as in recentUploads.',
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

/**
 * Internal membership whitelist: the candidates plus the pick's artist name, spelled as the profile
 * has it even when search found a case variant. A null name (a pick made before profiles) adds none.
 */
export function tagPool(fix: {
  artistName: string | null;
  candidateLists: CandidateList[];
}): TagCandidate[] {
  const artist = fix.artistName?.toLowerCase();
  const found = new Map<string, TagCandidate>();
  for (const list of fix.candidateLists) {
    for (const { tag } of list.tags) {
      const key = tag.toLowerCase();
      if (key !== artist && !found.has(key)) found.set(key, { tag });
    }
  }
  return [...found.values(), ...(fix.artistName ? [{ tag: fix.artistName }] : [])];
}

export function buildPickRequest(ctx: PickContext): ModelRequest {
  const { name, curated } = ctx.artist;
  const artistTag = ` Include "${name}". This required artist tag may be absent from the reference lists.`;
  const rules = [
    'Write one YouTube upload recommendation for a new music video: title, description, hashtags, tags.',
    "audienceTopVideos are genre search examples: model the title format and the description's structure and length on them. Do not claim these choices caused audience reach or success.",
    'candidateLists keep hashtags and tags labeled by their source video. Select across lists when relevant; do not pool, count, rank, or infer popularity from repeated terms.',
    "recentUploads are the artist's own uploads. Use them only for identity: credit lines and how the artist is named. Do not copy their structure, tags, or hashtags.",
    `title: at most ${TITLE_MAX} characters.`,
    `description: plain text whose structure and length follow the audienceTopVideos descriptions; its wording follows the artist voice below. Never open with or repeat the title: YouTube shows it right above. No hashtags inside it, they are appended separately. Only include links listed in facts.`,
    curated ? ARTIST_VOICE : GENERIC_VOICE,
    curated ? CREDIT_LINE : 'Write no credit line.',
    'Write no contact line, in the description or anywhere else.',
    "Correct spelling, capitalization, and grammar in everything you write, including wording taken from artistNotes or recentUploads. Keep the artist's slang, asides, the song title as styled, and the credited name exactly.",
    'hashtags: pick 3 to 5, copied exactly from a candidateLists hashtags entry, matching your tags where a candidate does. Never invent one.',
    `tags: pick 5 to ${MAX_TAGS}, each copied exactly from a candidateLists tags entry. Every tag must name something the windows heard: a genre, subgenre, style, or instrument a listener would search for. Skip mood, scene, and decade words (like neon, night city, 90s) unless the windows name them. Fewer strong tags beat many weak ones.${artistTag} Never the song title. Never invent one.`,
    ctx.brand
      ? "brandGuide is the artist's approved brand guide: follow keep, apply fix, avoid drop. It outranks patterns in the recent uploads."
      : '',
    `brandCheck: one sentence on how the proposal matches or departs from ${ctx.brand ? 'the brand guide' : 'the recent uploads'}.`,
    'why: one short reason per field naming its evidence: which audienceTopVideos or candidates it follows.',
    "bandcamp.about: the same song for Bandcamp's About field, in the artist voice, a few sentences at most. No hashtags, credits, or contact line.",
    curated
      ? 'bandcamp.credits: the credit line from the description, exactly as written there.'
      : 'bandcamp.credits: an empty string.',
    ctx.skipped.length > 0
      ? 'skippedVersions were rejected. Write a different title and a different description: new wording and a new angle, not a rearrangement of the skipped ones. The voice rules still apply.'
      : '',
  ].filter(Boolean);
  const context = {
    artist: name,
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
    brandGuide: ctx.brand ?? undefined,
    feedback: weighFeedback(ctx.feedback),
    skippedVersions: ctx.skipped.length > 0 ? ctx.skipped : undefined,
  };
  // YouTube data goes in its own tagged parts, so spans record a placeholder instead (research R13).
  const recentUploads = ctx.recent.map((v) => ({
    title: v.title,
    description: v.description.slice(0, RECENT_DESCRIPTION_CHARS),
    publishedAt: v.publishedAt,
  }));
  const audienceTopVideos = ctx.audience.map(({ title, description, tags }) => ({
    title,
    description,
    tags,
  }));
  const candidateLists = ctx.candidateLists.map(({ videoId, title, hashtags, tags }) => ({
    videoId,
    title,
    hashtags,
    tags: tags
      .filter(({ tag }) => tag.toLowerCase() !== name.toLowerCase())
      .map(({ tag }) => ({ tag })),
  }));
  return {
    system: rules.join('\n'),
    turns: [
      {
        role: 'user',
        parts: [
          { type: 'text', text: JSON.stringify(context) },
          youtubePart({ recentUploads }, recentUploads.length),
          youtubePart({ audienceTopVideos }, audienceTopVideos.length),
          youtubePart({ candidateLists }, candidateLists.length),
          ...imageParts(
            'Thumbnails of the recent uploads, newest first:',
            ctx.recent.map((v) => v.thumbnail),
          ),
        ],
      },
    ],
  };
}

const URL_PATTERN = /https?:\/\/[^\s)]+/g;

/** Keeps only links that appear in public FACT or APPROVED records. */
export function allowedLinks(text: string, facts: Fact[]): string {
  const allowed = new Set(
    facts
      .filter((f) => f.public && f.kind !== 'INFERENCE')
      .flatMap((f) => f.value.match(URL_PATTERN) ?? []),
  );
  return text.replaceAll(URL_PATTERN, (url) => (allowed.has(url) ? url : ''));
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
  artist: PickArtist;
  songTitle: string;
  chunks: Chunk[];
  candidateLists: CandidateList[];
  facts: Fact[];
  measurements: Measurements | null;
  probe: Probe | null;
};

const SHORT_MAX_SEC = 180;

/** YouTube publishes any square or vertical video of 3 minutes or less as a Short. */
export function shortFlag(probe: Probe | null): string[] {
  if (!probe?.width || !probe.height) return [];
  if (probe.height < probe.width || probe.durationSec > SHORT_MAX_SEC) return [];
  const shape = probe.height === probe.width ? 'Square' : 'Vertical';
  return [`${shape} and 3 minutes or shorter: YouTube will publish it as a Short`];
}

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

/** The windows' own quality flags, once each. */
export function windowFlags(chunks: Chunk[]): string[] {
  const seen = new Map<string, string>();
  for (const flag of chunks.flatMap((c) => c.analysis?.qualityFlags ?? [])) {
    const text = tidy(flag);
    if (text && !seen.has(text.toLowerCase())) seen.set(text.toLowerCase(), text);
  }
  return [...seen.values()];
}

/** 3 to 5 hashtags from the pool: the model's picks first, padded from the top of the pool. */
/** A tag's hashtag form: "dark synth" → "#darksynth". */
const asHashtag = (tag: string) => `#${tag.toLowerCase().replaceAll(/[^\p{L}\p{N}_]/gu, '')}`;

/**
 * 3 to 5 hashtags from the pool. Hashtags that match the chosen tags come first, so the description
 * and the tags field agree; then the model's other picks; then the top of the pool.
 */
function pickHashtags(draft: RawPick, pool: string[], tags: string[]): string[] {
  const byLower = new Map(pool.map((c) => [c.toLowerCase(), c]));
  const picked = [
    ...new Set([
      ...tags.map(asHashtag),
      ...[...draft.hashtags, ...parseHashtags(draft.description)].map((t) =>
        (t.startsWith('#') ? t : `#${t}`).toLowerCase(),
      ),
    ]),
  ]
    .filter((t) => byLower.has(t))
    .slice(0, 5);
  for (const candidate of pool) {
    if (picked.length >= 3) break;
    if (!picked.includes(candidate.toLowerCase())) picked.push(candidate.toLowerCase());
  }
  return picked.map((t) => byLower.get(t)!);
}

/** A line that is only a bracketed note, like "[Contact line: none provided]". */
const PLACEHOLDER_LINE = /^[ \t]*\[[^\]\n]*\][ \t]*$/gmu;
const MAX_TAGS = 10;

/** Fact links only, no hashtags, no placeholders: the rules every published text field follows. */
// tidy() runs first so `#<word>` can't turn into a hashtag after the brackets go.
const cleanText = (text: string, facts: Fact[]) =>
  tidy(
    tidy(allowedLinks(text, facts).replaceAll(PLACEHOLDER_LINE, '')).replaceAll(BODY_HASHTAG, ''),
  );

/**
 * Lines that look like contact details (research R10). Pattern-based, so it catches these forms and
 * not every way to write a contact; the Review step is the backstop.
 */
const CONTACT_PATTERNS = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/,
  /https?:\/\/|www\./i,
  /(?<![\w@])@[\w.]{2,}/,
  /^\s*(?:bookings?|contact|e-?mail|dms?|inquiries|enquiries|management|press)\b\s*[:-]?/i,
];
const PHONE = /\+?\d[\d\s().-]{6,}\d/g;
const PHONE_DIGITS = 8;

const isContactLine = (line: string) =>
  CONTACT_PATTERNS.some((pattern) => pattern.test(line)) ||
  [...line.matchAll(PHONE)].some(([match]) => match.replaceAll(/\D/g, '').length >= PHONE_DIGITS);

/** Drops stale contacts copied from uploads or feedback; the profile's own line is appended after. */
const dropContactLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => !isContactLine(line))
    .join('\n');

/** `text` clipped to leave room for `last`, which closes it on its own line and is never cut. */
function endWith(text: string, last: string | null, max: number): string {
  if (!last) return clip(text, max);
  const kept = clip(text, max - last.length - 1);
  return kept ? `${kept}\n${last}` : last;
}

/**
 * The artist tag first, then the model's picks from the pool that don't contain the song title, at
 * most 10 within YouTube's 500-character total. Nothing is filled from the pool: search membership
 * alone doesn't show the tag was heard.
 */
function pickTags(raw: string[], pool: string[], fix: PickFixups): string[] {
  const byLower = new Map(pool.map((t) => [t.toLowerCase(), t]));
  const picked = [...new Set(raw.map((t) => tidy(t.replace(/^#+/, '')).toLowerCase()))]
    .filter((key) => byLower.has(key) && !containsWords(key, fix.songTitle))
    .map((key) => byLower.get(key)!);
  return withArtistTag(fix.artist.name, picked, MAX_TAGS);
}

/**
 * Enforces R4 on the model's draft: hashtags only from candidates (3–5, closing the description),
 * links only from facts, plain-term tags with the artist's first, the profile's contact line placed
 * in code, YouTube limits, and no model-emitted audio numbers. Flags
 * come only from ffmpeg, the probe, and the windows' quality flags.
 */
export function finalizePick(raw: RawPick, fix: PickFixups): FinalPick {
  const draft = stripDeep(raw);
  const { name, contactLine } = fix.artist;
  const tags = pickTags(
    draft.tags,
    tagPool({ artistName: name, candidateLists: fix.candidateLists }).map((c) => c.tag),
    fix,
  );
  const allowedHashtags = [...new Set(fix.candidateLists.flatMap((list) => list.hashtags))];
  const hashtags = pickHashtags(draft, allowedHashtags, tags);

  const closing = hashtags.join(' ');
  const body = endWith(
    cleanText(dropContactLines(draft.description), fix.facts),
    contactLine,
    DESCRIPTION_MAX - closing.length - 2,
  );
  const description = closing ? `${body}\n\n${closing}`.trim() : body;

  return {
    description,
    hashtags,
    tags,
    title: clip(tidy(draft.title), TITLE_MAX),
    flags: [
      ...measuredFlags(fix.measurements),
      ...shortFlag(fix.probe),
      ...windowFlags(fix.chunks),
    ],
    brandCheck: draft.brandCheck,
    why: draft.why,
    bandcamp: {
      about: clip(cleanText(draft.bandcamp.about, fix.facts), DESCRIPTION_MAX),
      credits: endWith(
        cleanText(dropContactLines(draft.bandcamp.credits), fix.facts),
        contactLine,
        DESCRIPTION_MAX,
      ),
    },
    artistName: name,
  };
}

const normText = (t: string) =>
  t.replaceAll(BODY_HASHTAG, '').replaceAll(/\s+/g, ' ').trim().toLowerCase();

/** Same words, ignoring case, spacing, and hashtags, so a reshuffled closing line doesn't count as new. */
export const sameText = (a: string, b: string) => normText(a) === normText(b);

class Repeated extends Error {
  constructor(
    readonly value: RawPick,
    readonly fields: string[],
  ) {
    super('The pick repeats a skipped version.');
  }
}

/**
 * Runs the pick, retrying once when the title repeats a skipped version. Returns null when the
 * model's reply never parses. The step's `deadline` covers every call, re-asks included.
 */
export async function runPick(
  ctx: PickContext,
  deadline: number,
  span?: AgentSpan,
): Promise<{ pick: FinalPick; ms: number } | null> {
  let ms = 0;
  let request = buildPickRequest(ctx);
  if (span) agentInput(span, request);
  try {
    return await pRetry(
      async () => {
        const { value, ms: took } = await chatJson(
          request,
          'smart-pick',
          PICK_SCHEMA,
          isRawPick,
          deadline,
        );
        ms += took;
        if (!value) return null;
        const pick = finalizePick(value, ctx);
        const repeated = ctx.skipped.flatMap((s) => [
          ...(sameText(s.title, pick.title) ? ['title'] : []),
          ...(sameText(s.description, pick.description) ? ['description'] : []),
        ]);
        if (repeated.length > 0) throw new Repeated(value, [...new Set(repeated)]);
        if (span) agentOutput(span, JSON.stringify(pick));
        return { pick, ms };
      },
      {
        ...REASK_ONCE,
        onFailedAttempt: ({ error }) => {
          if (!(error instanceof Repeated)) return;
          const fields = error.fields.join(' and ');
          const verb = error.fields.length > 1 ? 'repeat' : 'repeats';
          request = {
            ...request,
            turns: [
              ...request.turns,
              textTurn('assistant', JSON.stringify(error.value)),
              textTurn(
                'user',
                `That ${fields} ${verb} a skipped version. Write a different ${fields}.`,
              ),
            ],
          };
        },
        shouldRetry: ({ error }) => error instanceof Repeated,
      },
    );
  } catch (error) {
    // A re-run must produce a new title and description; a second repeat fails the pick so the step retries.
    if (error instanceof Repeated) return null;
    throw error;
  }
}

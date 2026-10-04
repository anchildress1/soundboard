import type { BrandGuide } from '$lib/brand';
import {
  containsWords,
  DESCRIPTION_MAX,
  parseHashtags,
  tagsLength,
  TAGS_MAX,
  TITLE_MAX,
} from '$lib/metadata';
import type { Chunk, Measurements, Pick, Probe } from '$lib/types';
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
  required: ['title', 'description', 'hashtags', 'tags', 'flags', 'brandCheck', 'why', 'bandcamp'],
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
    typeof v.why.tags === 'string' &&
    typeof v.bandcamp === 'object' &&
    v.bandcamp !== null &&
    typeof v.bandcamp.about === 'string' &&
    typeof v.bandcamp.credits === 'string'
  );
}

export type PickContext = {
  songTitle: string;
  notes: string;
  chunks: Chunk[];
  measurements: Measurements | null;
  probe: Probe | null;
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
 * Applies to every run's description; the audience evidence still sets its structure and length.
 */
export const CONTACT_LINE = 'Contact at flieslikerobots@gmail.com.';

export const ARTIST_VOICE = [
  'Write the description the way the artist writes his own:',
  '- Short, plain, literal.',
  '- At most one sentence about the song, said straight, from artistNotes or what the windows show. Never claim what the lyrics say.',
  '- His credit line in his own wording, like "Written, performed, recorded, hacked and slashed by", with the credited name exactly as in recentUploads.',
  '- Album placement as a plain statement ("<song> is track 3 on the album <album>.") only when notes or facts give it.',
  `- After the credit line, his contact line exactly: "${CONTACT_LINE}"`,
  '- Never write placeholders, brackets, or notes about missing information.',
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
  const artist = ARTIST_NAME.toLowerCase();
  return [
    ...fix.tagCandidates.filter((c) => c.tag.toLowerCase() !== artist),
    { tag: ARTIST_NAME, usedBy: 0 },
  ];
}

export function buildPickMessages(ctx: PickContext): ChatMessage[] {
  const rules = [
    'Write one YouTube upload recommendation for a new music video: title, description, hashtags, tags.',
    "audienceTopVideos are the most-viewed music videos in this genre, ranked by views. They are the evidence for what reaches listeners: model the title format and the description's structure and length on them.",
    "recentUploads are the artist's own uploads. Use them only for identity: credit lines and how the artist is named. Do not copy their structure, tags, or hashtags.",
    `title: at most ${TITLE_MAX} characters.`,
    `description: plain text whose structure and length follow the audienceTopVideos descriptions; its wording follows the artist voice below. Never open with or repeat the title: YouTube shows it right above. No hashtags inside it, they are appended separately. Only include links listed in facts.`,
    ARTIST_VOICE,
    'Correct spelling, capitalization, and grammar in everything you write, including wording taken from artistNotes or recentUploads. Keep his slang, asides, the song title as styled, and the credited name exactly.',
    'hashtags: pick 3 to 5, copied exactly from candidateHashtags, matching your tags where a candidate does. Never invent one.',
    `tags: pick 5 to ${MAX_TAGS}, each copied exactly from a candidateTags tag. usedBy is how many of the genre's top videos use it. Every tag must name something the windows heard: a genre, subgenre, style, or instrument a listener would search for. Skip mood, scene, and decade words (like neon, night city, 90s) unless the windows name them. Fewer strong tags beat many weak ones. Include "${ARTIST_NAME}". Never the song title. Never invent one.`,
    'flags: problems a viewer would notice, taken from the window analysis. No loudness, level, or tempo numbers.',
    ctx.brand
      ? "brandGuide is the artist's approved brand guide: follow keep, apply fix, avoid drop. It outranks patterns in the recent uploads."
      : '',
    `brandCheck: one sentence on how the proposal matches or departs from ${ctx.brand ? 'the brand guide' : 'the recent uploads'}.`,
    'why: one short reason per field naming its evidence: which audienceTopVideos or candidates it follows.',
    "bandcamp.about: the same song for Bandcamp's About field, in the artist voice, a few sentences at most. No hashtags, credits, or contact line.",
    'bandcamp.credits: the credit line and contact line from the description, exactly as written there.',
    ctx.skipped.length > 0
      ? 'skippedVersions were rejected. Write a different title and a different description: new wording and a new angle, not a rearrangement of the skipped ones. The voice rules still apply.'
      : '',
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
const PLACEHOLDER_LINE = /^\s*\[[^\]\n]*\]\s*$/gmu;
const MAX_TAGS = 10;

/** Bandcamp fields follow the description's rules: fact links only, no hashtags, no placeholders. */
const bandcampText = (text: string, facts: Fact[]) =>
  clip(
    tidy(
      tidy(allowedLinks(text, facts).replaceAll(PLACEHOLDER_LINE, '')).replaceAll(BODY_HASHTAG, ''),
    ),
    DESCRIPTION_MAX,
  );

/**
 * The model's picks from the pool, never containing the song title, plus the artist name, at most
 * 10 within YouTube's 500-character total. Nothing is filled from the pool: search membership alone
 * doesn't show the tag was heard.
 */
function pickTags(raw: string[], pool: string[], songTitle: string): string[] {
  const byLower = new Map(pool.map((t) => [t.toLowerCase(), t]));
  const artist = ARTIST_NAME.toLowerCase();
  const allowed = (key: string) => byLower.has(key) && !containsWords(key, songTitle);
  const keys = [...new Set(raw.map((t) => tidy(t.replace(/^#+/, '')).toLowerCase()))].filter(
    allowed,
  );
  if (!keys.includes(artist)) keys.push(artist);
  while (keys.length > MAX_TAGS)
    keys.splice(
      keys.findLastIndex((k) => k !== artist),
      1,
    );
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
  const tags = pickTags(
    draft.tags,
    tagPool(fix).map((c) => c.tag),
    fix.songTitle,
  );
  const hashtags = pickHashtags(draft, fix.candidates, tags);

  // tidy() runs first so `#<word>` can't turn into a hashtag after the brackets go.
  let body = tidy(
    tidy(allowedLinks(draft.description, fix.facts).replaceAll(PLACEHOLDER_LINE, '')).replaceAll(
      BODY_HASHTAG,
      '',
    ),
  );
  const closing = hashtags.join(' ');
  body = clip(body, DESCRIPTION_MAX - closing.length - 2);
  const description = closing ? `${body}\n\n${closing}`.trim() : body;

  return {
    title: clip(tidy(draft.title), TITLE_MAX),
    description,
    hashtags,
    tags,
    flags: [
      ...measuredFlags(fix.measurements),
      ...shortFlag(fix.probe),
      ...draft.flags.filter(Boolean),
    ],
    brandCheck: draft.brandCheck,
    why: draft.why,
    bandcamp: {
      about: bandcampText(draft.bandcamp.about, fix.facts),
      credits: bandcampText(draft.bandcamp.credits, fix.facts),
    },
  };
}

/** Same words, ignoring case, spacing, and hashtags, so a reshuffled closing line doesn't count as new. */
export const sameText = (a: string, b: string) => {
  const norm = (t: string) =>
    t.replaceAll(BODY_HASHTAG, '').replaceAll(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
};

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
    const repeated = ctx.skipped.flatMap((s) => [
      ...(sameText(s.title, pick.title) ? ['title'] : []),
      ...(sameText(s.description, pick.description) ? ['description'] : []),
    ]);
    if (repeated.length === 0) return { pick, ms };
    // A re-run must produce a new title and description; a second repeat fails the pick so the step retries.
    if (attempt === 1) return null;
    const unique = [...new Set(repeated)];
    const fields = unique.join(' and ');
    const verb = unique.length > 1 ? 'repeat' : 'repeats';
    messages = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(value) },
      {
        role: 'user',
        content: `That ${fields} ${verb} a skipped version. Write a different ${fields}.`,
      },
    ];
  }
  return null;
}

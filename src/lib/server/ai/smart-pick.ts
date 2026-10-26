import type { BrandGuide, VoiceRules } from '#lib/brand.js';
import {
  containsWords,
  DESCRIPTION_MAX,
  parseHashtags,
  TITLE_MAX,
  withArtistTag,
} from '#lib/metadata.js';
import { ROLES, type Influence, type Role } from '#lib/influence.js';
import type { Chunk, Measurements, Pick, Probe, Recommendation } from '#lib/types.js';
import type { Fact, Feedback } from '#lib/server/artist/memory.js';
import type { PeerEvidence } from '#lib/server/research/evidence.js';
import type { PickOutcome } from '#lib/server/research/outcomes.js';
import { engagementRate } from '#lib/server/research/calculated.js';
import { soleSecondary } from '#lib/server/research/brackets.js';
import { checkCopy, type CopyViolation } from './copy-check';
import { checkInfluence, type Mismatch } from './influence-check';
import { chatJson, hasModelTime, type Asks } from './model';
import { stripDeep } from './numerics';
import { cleanCitations, cleanEvidence, influenceRules, type Refs } from './pick-sources';
import { isString, isStrings, shape, type Check } from './shape';
import { stripStats } from './stat-guard';
import type { AudienceVideo, CandidateList, TagCandidate } from '#lib/server/pipeline/hashtags.js';
import {
  agentInput,
  agentOutput,
  imageParts,
  youtubePart,
  type AgentSpan,
  type ModelRequest,
  type Turn,
} from '#lib/server/core/tracing.js';
import type { CatalogVideo, Thumbnail } from '#lib/server/platforms/youtube/index.js';

const stringArray = { type: 'array', items: { type: 'string' } };
const FOLLOWS = ['artist', 'peers', 'both', 'none'];

export const PICK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'description',
    'hashtags',
    'tags',
    'brandCheck',
    'why',
    'bandcamp',
    'citations',
    'recommendation',
  ],
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
    citations: {
      type: 'object',
      additionalProperties: false,
      required: [...ROLES],
      properties: Object.fromEntries(ROLES.map((role) => [role, stringArray])),
    },
    recommendation: {
      type: 'object',
      additionalProperties: false,
      required: ['approach', 'intendedOutcome', 'follows', 'followsWhy', 'evidence'],
      properties: {
        approach: { type: 'string' },
        intendedOutcome: { type: 'string' },
        follows: { type: 'string', enum: FOLLOWS },
        followsWhy: { type: 'string' },
        evidence: stringArray,
      },
    },
  },
} as const;

/** The model's reply. Flags are never the model's: `finalizePick` builds them from measured evidence. */
export type RawPick = Omit<Pick, 'version' | 'modelMs' | 'flags' | 'artistName' | ServerFields> & {
  citations: Record<Role, string[]>;
  recommendation: Omit<Recommendation, 'limits'>;
};
export type FinalPick = Omit<Pick, 'version' | 'modelMs'>;

/** The fields only the server fills in. */
type ServerFields =
  | 'influence'
  | 'influenceWarning'
  | 'researchRunId'
  | 'evidenceExpiresAt'
  | 'outcomeRefs'
  | 'limits'
  | 'citations'
  | 'recommendation';

const RAW_PICK = shape({
  title: isString,
  description: isString,
  hashtags: isStrings,
  tags: isStrings,
  brandCheck: isString,
  why: shape({ title: isString, description: isString, tags: isString }),
  bandcamp: shape({ about: isString, credits: isString }),
  citations: shape(Object.fromEntries(ROLES.map((role) => [role, isStrings]))),
  recommendation: shape({
    approach: isString,
    intendedOutcome: isString,
    follows: ((value) => FOLLOWS.includes(value as string)) satisfies Check,
    followsWhy: isString,
    evidence: isStrings,
  }),
});

export function isRawPick(value: unknown): value is RawPick {
  return RAW_PICK(value);
}

/** The job owner's profile as the pick uses it. */
export type PickArtist = { name: string; contactLine: string | null };

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
  /** The owner's approved voice; null before one is approved, or when the job can't use it. */
  voice: VoiceRules | null;
  /** The owner's approved brand guide; null before one is approved, or when the job can't use it. */
  brand: BrandGuide | null;
  /** How strongly similar artists shape each part of this draft. */
  influence: Influence;
  /** The run's peers and releases without rejected channels; null when there are none to use. */
  evidence: PeerEvidence | null;
  /** The artist's own fresh results, `A<n>` in this order. */
  outcomes: PickOutcome[];
  /** Server-built notes on what the draft couldn't use; they close the recommendation. */
  limits: string[];
};

/** Every ref the job's sources carry, so the reply's refs can be checked against them. */
export function refsOf(ctx: SourceHolder): Refs {
  const lists = ctx.candidateLists;
  return {
    genre: lists.filter((list) => list.source === 'genre').map((list) => list.ref),
    peers: ctx.evidence?.peers.map((peer) => peer.ref) ?? [],
    releases: ctx.evidence?.releases.map((release) => release.ref) ?? [],
    outcomes: ctx.outcomes.map((outcome) => outcome.ref),
  };
}
type SourceHolder = {
  candidateLists: CandidateList[];
  evidence: PeerEvidence | null;
  outcomes: PickOutcome[];
};

const RECENT_DESCRIPTION_CHARS = 700;

/** Plain-copy rules for an artist with no approved voice; never another artist's voice. */
export const GENERIC_VOICE = [
  'Write the description in plain words:',
  '- Short, plain, literal.',
  '- At most one sentence about the song, said straight, from artistNotes or what the windows show. Never claim what the lyrics say.',
  '- Album placement as a plain statement ("<song> is track 3 on the album <album>.") only when notes or facts give it.',
  '- Never write placeholders, brackets, or notes about missing information.',
  '- No marketing copy: no "explores", "journey", "sonic", "soundscape", "for fans of", no calls to like or subscribe, no emoji.',
].join('\n');

/** The artist's approved rules, or `GENERIC_VOICE` before they approve any. */
export function voiceBlock(voice: VoiceRules | null): string {
  if (!voice) return GENERIC_VOICE;
  return [
    'Write the description the way the artist writes their own:',
    ...voice.rules.map((rule) => `- ${rule}`),
  ].join('\n');
}

/** FR-008: the app's content rules win over anything the voice asks for. */
export const CONTENT_RULES =
  "These content rules outrank the voice rules: hashtags and tags only from candidateLists, no loudness, peak, clipping or silence figures except ffmpeg's, YouTube length limits, and facts, credits and links only from artistNotes, facts and recentUploads. Never write placeholders.";

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

/** Keyed by ref, so a ref is never a value Sentry has to redact from the reply. */
const byRef = <T>(items: T[], ref: (item: T) => string, value: (item: T) => unknown) =>
  Object.fromEntries(items.map((item) => [ref(item), value(item)]));

/** Reported counts and calculated values, each labeled as what it is. */
function peerSources(evidence: PeerEvidence | null) {
  const peers = evidence?.peers ?? [];
  const releases = evidence?.releases ?? [];
  return {
    // Our own labels: no YouTube text or number in them.
    labels: {
      similarArtists: byRef(
        peers,
        (peer) => peer.ref,
        (peer) => ({ relation: peer.relation, basis: peer.basis, secondary: peer.secondary }),
      ),
      peerReleases: byRef(
        releases,
        (release) => release.ref,
        (release) => ({ selectedAs: release.selectedAs }),
      ),
    },
    similarArtists: byRef(
      peers,
      (peer) => peer.ref,
      (peer) => ({
        explanation: peer.explanation,
        publicReachReportedByYouTube: {
          subscribers: peer.stats.hidden ? 'hidden' : peer.stats.subscribers,
          videos: peer.stats.videos,
          views: peer.stats.views,
        },
      }),
    ),
    peerReleases: byRef(
      releases,
      (release) => release.ref,
      (release) => ({
        title: release.title,
        description: release.description,
        durationSec: release.durationSec,
        publishedAt: release.publishedAt,
        publicReachReportedByYouTube: release.stats,
        engagementRate: engagementRate(release.stats),
      }),
    ),
  };
}

function resultSources(outcomes: PickOutcome[]) {
  return byRef(
    outcomes,
    (outcome) => outcome.ref,
    (outcome) => ({
      suggested: outcome.suggested,
      published: outcome.published,
      editedBeforeApproval: outcome.editedBeforeApproval,
      changedOnYouTubeSinceApproval: outcome.differsFromApproved,
      liveOnYouTubeNow: outcome.live,
      coverage: outcome.coverage,
      window: outcome.window,
      reportedByYouTube: {
        views: outcome.metrics.views,
        subscribersGained: {
          value: outcome.metrics.subscribersGained,
          note: "counted on this video's page; a lower bound",
        },
        subscribersLost: outcome.metrics.subscribersLost,
      },
      netSubscribers: outcome.net,
    }),
  );
}

const SOURCES_RULE =
  "Sources, by ref: analysis = windows; voice = the voice rules below; edits = feedback, the artist's own preference and never evidence of reach; identity = recentUploads; G<n> = a candidateLists entry from the genre search";

/** The prompt rules that tell the model what evidence it has and how to use each source. */
function evidenceRules(ctx: PickContext, refs: Refs): string[] {
  const peered = refs.releases.length > 0;
  const results = refs.outcomes.length > 0;
  return [
    peered
      ? "peerReleases are other artists' releases comparable to this one, each chosen within its own artist as newest, most viewed or most engaged (see peerLabels). Model the title format and the description's structure and length on them. Do not claim these choices caused reach or success."
      : "audienceTopVideos are genre search examples: model the title format and the description's structure and length on them. Do not claim these choices caused audience reach or success.",
    `${SOURCES_RULE}${refs.peers.length > 0 ? '; P<n> = a similarArtists entry; P<n>-R<m> = a peerReleases entry, whose hashtags and tags are the candidateLists entry with the same ref' : ''}${results ? '; A<n> = an artistResults entry' : ''}.`,
    refs.peers.length > 0
      ? `Similar artists shape each part of the draft as far as its level says. Follow the level, and cite what you followed:\n${influenceRules(ctx.influence)}`
      : "No similar-artist evidence is available. Cite only the artist's own sources.",
    results
      ? 'artistResults are the artist’s own uploads. suggested is what a past recommendation proposed; published is what the artist actually posted, which may differ (editedBeforeApproval); liveOnYouTubeNow is how the video reads now. Their results measure fans and reach; similar-artist evidence measures reach only. Repeated comparable results from the artist outrank loose observations about other artists.'
      : '',
    'citations: for sound, feel, wording, discovery and structure, the refs that part of your draft followed, only from the sources that part may cite.',
    "recommendation: one thing to try for this release, said tentatively. approach: what to try. intendedOutcome: the reach or fan outcome hoped for. follows: 'artist' when it rests on the artist's own sources or results, 'peers' on similar artists, 'both', or 'none' when the evidence is too sparse (then say so). followsWhy: why it follows what it does, and which side you follow when artist and peer evidence disagree. evidence: the refs it rests on. Heard artists outrank metadata-only ones and next-range artists outrank secondary ones; a recommendation never rests only on secondary artists. Never state a cause.",
    'Never write a number about views, subscribers, likes, comments or engagement; point to the source by ref instead. Refer to similar artists only by ref, never by name.',
  ].filter(Boolean);
}

export function buildPickRequest(ctx: PickContext): ModelRequest {
  const { name } = ctx.artist;
  const voiced = ctx.voice !== null;
  const refs = refsOf(ctx);
  const peered = refs.releases.length > 0;
  const artistTag = ` Include "${name}". This required artist tag may be absent from the reference lists.`;
  const rules = [
    'Write one YouTube upload recommendation for a new music video: title, description, hashtags, tags.',
    ...evidenceRules(ctx, refs),
    'candidateLists keep hashtags and tags labeled by their source video. Select across lists when relevant; do not pool, count, rank, or infer popularity from repeated terms.',
    "recentUploads are the artist's own uploads. Use them only for identity: credit lines and how the artist is named. Do not copy their structure, tags, or hashtags.",
    `title: at most ${TITLE_MAX} characters.`,
    `description: plain text whose structure and length follow the ${peered ? 'peerReleases' : 'audienceTopVideos'} descriptions; its wording follows the artist voice below. Never open with or repeat the title: YouTube shows it right above. No hashtags inside it, they are appended separately. Only include links listed in facts.`,
    voiceBlock(ctx.voice),
    CONTENT_RULES,
    voiced
      ? 'Write a credit line only as the voice rules say, with the credited name exactly as in recentUploads.'
      : 'Write no credit line.',
    'Write no contact line, in the description or anywhere else.',
    "Correct spelling, capitalization, and grammar in everything you write, including wording taken from artistNotes or recentUploads. Keep the artist's slang, asides, the song title as styled, and the credited name exactly.",
    'hashtags: pick 3 to 5, copied exactly from a candidateLists hashtags entry, matching your tags where a candidate does. Never invent one.',
    `tags: pick 5 to ${MAX_TAGS}, each copied exactly from a candidateLists tags entry. Every tag must name something the windows heard: a genre, subgenre, style, or instrument a listener would search for. Skip mood, scene, and decade words (like neon, night city, 90s) unless the windows name them. Fewer strong tags beat many weak ones.${artistTag} Never the song title. Never invent one.`,
    ctx.brand
      ? "brandGuide is the artist's approved brand guide: follow keep, apply fix, avoid drop. It outranks patterns in the recent uploads."
      : '',
    `brandCheck: one sentence on how the proposal matches or departs from ${ctx.brand ? 'the brand guide' : 'the recent uploads'}.`,
    `why: one short reason per field naming its evidence: which refs it follows.`,
    "bandcamp.about: the same song for Bandcamp's About field, in the artist voice, a few sentences at most. No hashtags, credits, or contact line.",
    voiced
      ? 'bandcamp.credits: the credit line from the description, exactly as written there.'
      : 'bandcamp.credits: an empty string.',
    ctx.skipped.length > 0
      ? 'skippedVersions were rejected. Write a different title and a different description: new wording and a new angle, not a rearrangement of the skipped ones. The voice rules still apply.'
      : '',
  ].filter(Boolean);
  const sources = peerSources(ctx.evidence);
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
    peerLabels: refs.peers.length > 0 ? sources.labels : undefined,
  };
  // YouTube data goes in its own tagged parts, so spans record a placeholder instead (research R13).
  const recentUploads = ctx.recent.map((v) => ({
    title: v.title,
    description: v.description.slice(0, RECENT_DESCRIPTION_CHARS),
    publishedAt: v.publishedAt,
  }));
  const audienceTopVideos = peered
    ? []
    : ctx.audience.map(({ title, description, tags }) => ({ title, description, tags }));
  const candidateLists = byRef(
    ctx.candidateLists,
    (list) => list.ref,
    ({ videoId, title, hashtags, tags }) => ({
      videoId,
      title,
      hashtags,
      tags: tags
        .filter(({ tag }) => tag.toLowerCase() !== name.toLowerCase())
        .map(({ tag }) => ({ tag })),
    }),
  );
  const { similarArtists, peerReleases } = sources;
  const artistResults = resultSources(ctx.outcomes);
  return {
    system: rules.join('\n'),
    turns: [
      {
        role: 'user',
        parts: [
          { type: 'text', text: JSON.stringify(context) },
          youtubePart({ recentUploads }, recentUploads.length),
          ...(peered ? [] : [youtubePart({ audienceTopVideos }, audienceTopVideos.length)]),
          ...(refs.peers.length > 0
            ? [
                youtubePart({ similarArtists }, refs.peers.length, 'YouTube peers'),
                youtubePart({ peerReleases }, refs.releases.length, 'YouTube releases'),
              ]
            : []),
          ...(ctx.outcomes.length > 0
            ? [youtubePart({ artistResults }, ctx.outcomes.length, 'YouTube outcomes')]
            : []),
          youtubePart({ candidateLists }, ctx.candidateLists.length),
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
  influence: Influence;
  evidence: PeerEvidence | null;
  outcomes: PickOutcome[];
  limits: string[];
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
  // Presence only (`.test`), so the shortest email shape matches the same lines without backtracking.
  /[\w.+-]@[\w-]+\.[\w-]/,
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

/** The model never writes a statistic: sentences that state one are removed (research R7). */
const unstated = (text: string) => stripStats(text).text;

/**
 * `text` with every case-insensitive `needle` replaced. It scans by index over a folded copy that
 * remembers where each folded unit came from, so a character whose lowercase is longer (İ) can't
 * shift the cuts, and no pattern is built from a channel title.
 */
function replaceFolded(text: string, needle: string, replacement: string): string {
  const target = needle.toLowerCase();
  if (!target) return text;
  let folded = '';
  const origin: number[] = [];
  let index = 0;
  for (const char of text) {
    const lower = char.toLowerCase();
    origin.push(...Array.from({ length: lower.length }, () => index));
    folded += lower;
    index += char.length;
  }
  origin.push(text.length);
  let out = '';
  let from = 0;
  let at = folded.indexOf(target);
  while (at >= 0) {
    const next = at + target.length;
    out += text.slice(from, origin[at]) + replacement;
    from = origin[next]!;
    at = folded.indexOf(target, next);
  }
  return out + text.slice(from);
}

/** `text` with each peer's channel title replaced by the peer's ref. */
const byRefOnly = (text: string, peers: { ref: string; title: string }[]): string =>
  peers.reduce((acc, peer) => replaceFolded(acc, peer.title.trim(), peer.ref), text);

/**
 * Enforces R4 on the model's draft: hashtags only from candidates (3–5, closing the description),
 * links only from facts, plain-term tags with the artist's first, the profile's contact line placed
 * in code, YouTube limits, and no model-emitted audio numbers or statistics. Citations and
 * evidence keep only refs the job has and the role may cite. Flags come only from ffmpeg, the
 * probe, and the windows' quality flags.
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
    cleanText(dropContactLines(unstated(draft.description)), fix.facts),
    contactLine,
    DESCRIPTION_MAX - closing.length - 2,
  );
  const description = closing ? `${body}\n\n${closing}`.trim() : body;
  const refs = refsOf(fix);
  const peers = fix.evidence?.peers ?? [];
  const { recommendation: advice } = draft;

  return {
    description,
    hashtags,
    tags,
    title: clip(tidy(unstated(draft.title)), TITLE_MAX),
    flags: [
      ...measuredFlags(fix.measurements),
      ...shortFlag(fix.probe),
      ...windowFlags(fix.chunks),
    ],
    brandCheck: unstated(draft.brandCheck),
    why: {
      title: unstated(draft.why.title),
      description: unstated(draft.why.description),
      tags: unstated(draft.why.tags),
    },
    bandcamp: {
      about: clip(cleanText(unstated(draft.bandcamp.about), fix.facts), DESCRIPTION_MAX),
      credits: endWith(
        cleanText(dropContactLines(unstated(draft.bandcamp.credits)), fix.facts),
        contactLine,
        DESCRIPTION_MAX,
      ),
    },
    artistName: name,
    influence: fix.influence,
    citations: cleanCitations(draft.citations, refs),
    recommendation: {
      approach: unstated(byRefOnly(advice.approach, peers)),
      intendedOutcome: unstated(byRefOnly(advice.intendedOutcome, peers)),
      follows: advice.follows,
      followsWhy: unstated(byRefOnly(advice.followsWhy, peers)),
      evidence: cleanEvidence(advice.evidence, refs),
      limits: fix.limits,
    },
    influenceWarning: null,
    outcomeRefs: Object.fromEntries(fix.outcomes.map((o) => [o.ref, o.videoId])),
    limits: fix.limits,
  };
}

const normText = (t: string) =>
  t.replaceAll(BODY_HASHTAG, '').replaceAll(/\s+/g, ' ').trim().toLowerCase();

/** Same words, ignoring case, spacing, and hashtags, so a reshuffled closing line doesn't count as new. */
export const sameText = (a: string, b: string) => normText(a) === normText(b);

/** Skipped versions the pick repeats: title, description, or both. */
export function repeatedFields(pick: FinalPick, skipped: PickContext['skipped']): string[] {
  const fields = skipped.flatMap((s) => [
    ...(sameText(s.title, pick.title) ? ['title'] : []),
    ...(sameText(s.description, pick.description) ? ['description'] : []),
  ]);
  return [...new Set(fields)];
}

function repeatAsk(fields: string[]): string {
  const named = fields.join(' and ');
  return `That ${named} ${fields.length > 1 ? 'repeat' : 'repeats'} a skipped version. Write a different ${named}.`;
}

/** A draft that still copies a similar artist after its one re-ask: the step fails and a retry re-picks. */
export class CopiedWording extends Error {
  constructor() {
    super("The draft copied a similar artist's wording. Try again.");
  }
}

export const INFLUENCE_WARNING = 'Influence settings not met';

/** What each check found in one reply. */
type Findings = {
  repeated: string[];
  mismatches: Mismatch[];
  copied: CopyViolation[];
  secondaryOnly: boolean;
  limits: string[];
};

const terms = (lists: CandidateList[]) =>
  lists.flatMap((list) => [...list.hashtags, ...list.tags.map(({ tag }) => tag)]);

/** Peer text a draft must not copy, and the artist's own words it may share (research R12). */
function copyContext(ctx: PickContext) {
  const { evidence } = ctx;
  const peers = (evidence?.peers ?? []).map((peer) => ({
    channelTitle: peer.title,
    texts: [
      evidence!.candidates.find((c) => c.channelId === peer.channelId)?.description ?? '',
      ...evidence!.releases
        .filter((release) => release.peer === peer.ref)
        .flatMap((release) => [release.title, release.description]),
    ].filter(Boolean),
  }));
  return {
    peers,
    own: [
      ...(ctx.voice?.rules ?? []),
      ...ctx.feedback.flatMap((f) => [f.before ?? '', f.after ?? '']),
      ...ctx.recent.flatMap((v) => [v.title, v.description]),
      ctx.notes,
      ...ctx.facts.map((fact) => fact.value),
    ],
    analysis: digestChunks(ctx.chunks).flatMap((w) =>
      [
        w.visual,
        ...(w.genre ?? []),
        w.tempoFeel,
        ...(w.instrumentation ?? []),
        w.vocals,
        ...(w.mood ?? []),
      ].filter((text): text is string => typeof text === 'string'),
    ),
    terms: terms(ctx.candidateLists),
    names: [ctx.songTitle, ctx.artist.name],
  };
}

function findings(pick: FinalPick, ctx: PickContext): Findings {
  const refs = refsOf(ctx);
  const influence = checkInfluence(pick.citations!, ctx.influence, {
    peers: refs.peers,
    releases: refs.releases,
  });
  return {
    repeated: repeatedFields(pick, ctx.skipped),
    mismatches: influence.failing,
    copied: checkCopy(
      {
        title: pick.title,
        description: pick.description,
        'Bandcamp about': pick.bandcamp.about,
        'Bandcamp credits': pick.bandcamp.credits,
      },
      copyContext(ctx),
    ),
    secondaryOnly: soleSecondary(pick.recommendation?.evidence ?? [], ctx.evidence?.peers ?? []),
    // With no peers at all, the run's own limit already says so; one line per role would only repeat it.
    limits: refs.peers.length > 0 ? influence.limits : [],
  };
}

const SECONDARY_ASK =
  'The recommendation rests only on secondary (two range up) artists. Base it on the artist’s own sources or results, or on next-range or same-range artists, as well.';

/**
 * One turn naming every failure, so a single re-ask fixes them all. The copy messages quote peer
 * text, so they go in a YouTube part that spans record only as a count.
 */
const askFor = (found: Findings): Turn | null => {
  const asks = [
    ...(found.repeated.length > 0 ? [repeatAsk(found.repeated)] : []),
    ...found.mismatches.map((m) => m.problem),
    ...(found.secondaryOnly ? [SECONDARY_ASK] : []),
  ];
  const copied = found.copied.map((c) => c.message);
  if (asks.length === 0 && copied.length === 0) return null;
  return {
    role: 'user',
    parts: [
      ...(asks.length > 0 ? [{ type: 'text' as const, text: asks.join(' ') }] : []),
      ...(copied.length > 0 ? [youtubePart(copied, copied.length, 'Copied peer wording')] : []),
    ],
  };
};

/** The pick as it is kept: what the checks found is a limit or a warning, never hidden. */
function settled(pick: FinalPick, found: Findings): FinalPick {
  const limits = [...new Set([...(pick.limits ?? []), ...found.limits])];
  const kept = found.secondaryOnly ? [...limits, 'secondary-only'] : limits;
  return {
    ...pick,
    limits: kept,
    recommendation: found.secondaryOnly
      ? null
      : pick.recommendation && { ...pick.recommendation, limits },
    influenceWarning: found.mismatches.length > 0 ? INFLUENCE_WARNING : null,
  };
}

/**
 * Runs the pick under one re-ask allowance shared by every check: a reply that doesn't parse, a
 * title or description that repeats a skipped version, citations that miss a slider level, copied
 * wording, and a recommendation resting only on secondary artists. Once it is spent: a repeat or a
 * reply that never parses returns null, copied wording throws, a missed level becomes a warning,
 * and secondary-only evidence drops the recommendation. The step's `deadline` covers every call.
 */
export async function runPick(
  ctx: PickContext,
  deadline: number,
  span?: AgentSpan,
): Promise<{ pick: FinalPick; ms: number } | null> {
  const asks: Asks = { left: 1 };
  let ms = 0;
  let request = buildPickRequest(ctx);
  if (span) agentInput(span, request);
  for (;;) {
    const reply = await chatJson(request, 'smart-pick', PICK_SCHEMA, isRawPick, deadline, asks);
    ms += reply.ms;
    if (!reply.value) return null;
    const pick = finalizePick(reply.value, ctx);
    const found = findings(pick, ctx);
    const ask = askFor(found);
    if (ask && asks.left > 0 && hasModelTime('smart-pick', deadline)) {
      asks.left -= 1;
      request = { ...request, turns: [...reply.turns, ask] };
      continue;
    }
    // A re-run must produce a new title and description; a repeat that survives fails the step.
    if (found.repeated.length > 0) return null;
    if (found.copied.length > 0) throw new CopiedWording();
    const kept = settled(pick, found);
    if (span) agentOutput(span, JSON.stringify(kept), 'smart-pick');
    return { pick: kept, ms };
  }
}

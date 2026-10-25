import {
  VOICE_RULE_MAX,
  VOICE_RULES_MAX,
  VOICE_UPLOADS,
  type ProposalSources,
  type UploadSource,
  type VoiceRules,
} from '#lib/brand.js';
import { chatJson, hasModelTime, modelFor } from '#lib/server/ai/model.js';
import { stripDeep } from '#lib/server/ai/numerics.js';
import { isStrings, shape } from '#lib/server/ai/shape.js';
import { query } from '#lib/server/core/db.js';
import { ActionError } from '#lib/server/core/errors.js';
import { artistMemory } from '#lib/server/core/schema.js';
import {
  agentInput,
  agentOutput,
  invokeAgent,
  type ModelRequest,
  type Part,
} from '#lib/server/core/tracing.js';
import {
  getConnection,
  ownChannelUploads,
  type CatalogVideo,
} from '#lib/server/platforms/youtube/index.js';
import { cleanRules } from './brand';
import { proposeStep, type ProposeResult } from './guides';
import { memoryOf, recentFeedback, type Feedback } from './memory';

/** Research R5: what one voice proposal reads. */
const DESCRIPTION_CHARS = 1_500;
const FEEDBACK_ROWS = 60;
const EDIT_CHARS = 600;
const PROSE_WORDS = 15;
/** Below this many artist-written descriptions plus edits, the evidence is thin. */
const THIN_BELOW = 5;
const THIN_RULES = 3;

export const VOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rules'],
  properties: { rules: { type: 'array', items: { type: 'string' } } },
} as const;

const VOICE_RULES = shape({ rules: isStrings });

export function isVoiceRules(value: unknown): value is VoiceRules {
  return VOICE_RULES(value);
}

type Upload = UploadSource & { description: string };
type Edit = { field: 'title' | 'description'; song: string; before: string; after: string };

export type VoiceEvidence = {
  written: Upload[];
  drafts: Upload[];
  edits: Edit[];
  /** Final titles the artist approved as drafted. */
  approvals: string[];
  thin: boolean;
};

const clip = (text: string, max: number) => text.trim().slice(0, max).trim();

/** Prose is at least 15 words once links and hashtags are gone. */
const isProse = (text: string) =>
  text
    .replaceAll(/https?:\/\/\S+/g, ' ')
    .replaceAll(/(?<!\S)#\S+/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length >= PROSE_WORDS;

const isTextEdit = (f: Feedback): f is Feedback & { field: 'title' | 'description' } =>
  f.kind === 'EDITED' && (f.field === 'title' || f.field === 'description');

/**
 * The voice evidence (research R5). Uploads Soundboard drafted and the artist published (a `publish`
 * memory row) are drafts, kept apart from the artist's own writing; uploads with no description
 * say nothing. Edits to titles and descriptions are strong evidence, approvals weak; skips and tag
 * edits say nothing about wording.
 */
export async function voiceEvidence(
  artistId: string,
  uploads: CatalogVideo[],
): Promise<VoiceEvidence> {
  const [published, feedback] = await Promise.all([
    query((tx) =>
      tx.select({ key: artistMemory.key }).from(artistMemory).where(memoryOf(artistId, 'publish')),
    ),
    recentFeedback(artistId, FEEDBACK_ROWS),
  ]);
  const drafted = new Set(published.map((row) => row.key));
  const used = uploads
    .map(({ videoId, title, publishedAt, description }) => ({
      videoId,
      title,
      publishedAt,
      description: clip(description, DESCRIPTION_CHARS),
    }))
    .filter((upload) => upload.description);
  const written = used.filter((upload) => !drafted.has(upload.videoId));
  const edits = feedback.filter(isTextEdit).map((f) => ({
    field: f.field,
    song: f.songTitle,
    before: clip(f.before ?? '', EDIT_CHARS),
    after: clip(f.after ?? '', EDIT_CHARS),
  }));
  const approvals = feedback.filter((f) => f.kind === 'ACCEPTED').map((f) => f.after ?? '');
  const prose = written.filter((upload) => isProse(upload.description)).length;
  return {
    written,
    drafts: used.filter((upload) => drafted.has(upload.videoId)),
    edits,
    approvals,
    thin: prose + edits.length < THIN_BELOW,
  };
}

const uploadPart = (heading: string, uploads: Upload[]): Part[] =>
  uploads.length === 0
    ? []
    : [
        {
          type: 'text',
          text: `${heading}:\n${JSON.stringify(uploads.map(({ title, description }) => ({ title, description })))}`,
          // Tagged so spans record a placeholder, never the uploads' text (research R4).
          source: 'youtube',
          count: uploads.length,
        },
      ];

export function buildVoiceRequest(evidence: VoiceEvidence): ModelRequest {
  const rules = [
    'Write the rules a writer needs to sound like this artist in a YouTube description: tone, sentence shape, recurring lines (quoted exactly), things the artist avoids.',
    '"Written by the artist" is the artist\'s writing. "Approved Soundboard drafts (lower weight)" were drafted by Soundboard and approved by the artist: weigh them below the artist\'s own writing and edits.',
    "In edits, after is the artist's writing and before is not. Approvals are titles the artist kept as drafted: weak evidence.",
    "Base every rule on the evidence. Don't invent a style it doesn't show.",
    'No rules about hashtags, tags, links, contact lines, audio measurements or length: the app sets those.',
    evidence.thin
      ? `The evidence is thin: write at most ${THIN_RULES} rules.`
      : `At most ${VOICE_RULES_MAX} rules.`,
  ];
  const soundboard = {
    edits: evidence.edits.map((edit) => ({ weight: 'strong', ...edit })),
    approvals: evidence.approvals.map((title) => ({ weight: 'weak', title })),
  };
  return {
    system: rules.join('\n'),
    turns: [
      {
        role: 'user',
        parts: [
          ...uploadPart('Written by the artist', evidence.written),
          ...uploadPart('Approved Soundboard drafts (lower weight)', evidence.drafts),
          { type: 'text', text: `Soundboard edits, newest first:\n${JSON.stringify(soundboard)}` },
        ],
      },
    ],
  };
}

/** Trims, caps and dedupes the rules, and strips any audio figures the model emits. */
export function cleanVoice(raw: VoiceRules, thin = false): VoiceRules {
  const count = thin ? THIN_RULES : VOICE_RULES_MAX;
  return { rules: cleanRules(stripDeep(raw).rules, VOICE_RULE_MAX, count) };
}

/** The edited voice from an approve body, trimmed; a wrong shape is a 400. */
export function voiceInput(input: unknown): VoiceRules {
  if (!isVoiceRules(input)) throw new ActionError(400, 'Expected voice rules.');
  return { rules: input.rules.map((r) => r.trim()).filter(Boolean) };
}

const source = ({ videoId, title, publishedAt }: Upload): UploadSource => ({
  videoId,
  title,
  publishedAt,
});

/**
 * Proposes the owner's voice as one claimed step, from their own uploads (read on their own grant)
 * and their Soundboard edits. Without a connected channel it learns from edits alone; a lost grant,
 * a busy YouTube, a busy model or a spent quota returns its wait and saves nothing.
 */
export async function proposeVoice(user: {
  uid: string;
  artistId: string;
}): Promise<ProposeResult<VoiceRules>> {
  return await proposeStep(user.artistId, 'voice', async (deadline) => {
    const connection = await getConnection(user.uid);
    let uploads: CatalogVideo[] = [];
    if (connection && connection.status !== 'no_channel') {
      const read = await ownChannelUploads(user.uid, VOICE_UPLOADS, deadline, {
        'guide.kind': 'voice',
      });
      if (!Array.isArray(read)) return read;
      uploads = read;
    }
    const evidence = await voiceEvidence(user.artistId, uploads);
    if (evidence.written.length + evidence.drafts.length + evidence.edits.length === 0) {
      throw new ActionError(
        409,
        'Nothing to learn from yet. Connect YouTube or finish a few releases first.',
      );
    }
    if (!hasModelTime('voice-guide', deadline)) return { wait: 'model busy' };

    const voice = await invokeAgent('voice-guide', modelFor('voice-guide'), async (span) => {
      span.setAttribute('voice.upload_count', evidence.written.length + evidence.drafts.length);
      const request = buildVoiceRequest(evidence);
      agentInput(span, request);
      const { value } = await chatJson(
        request,
        'voice-guide',
        VOICE_SCHEMA,
        isVoiceRules,
        deadline,
      );
      if (!value) return null;
      const cleaned = cleanVoice(value, evidence.thin);
      agentOutput(span, JSON.stringify(cleaned), 'voice-guide');
      return cleaned;
    });
    if (!voice || voice.rules.length === 0)
      throw new ActionError(502, 'The model reply did not parse as a voice. Try again.');
    const sources: ProposalSources = {
      uploads: evidence.written.map(source),
      drafts: evidence.drafts.map(source),
      edits: evidence.edits.length,
      approvals: evidence.approvals.length,
      thin: evidence.thin,
    };
    return { body: voice, sources };
  });
}

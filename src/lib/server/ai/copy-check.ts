// Blocks a draft that copies a peer (research R12, FR-022, constitution II). Deterministic, on
// lowercased words with punctuation ignored.

/** One peer's text: its channel title, and its release titles, descriptions and channel description. */
export type PeerText = { channelTitle: string; texts: string[] };

export type CopyContext = {
  peers: PeerText[];
  /** The artist's own words: voice rules, edits, recent uploads. */
  own: string[];
  /** The song analysis text. */
  analysis: string[];
  /** Every term of the job's candidate lists (tags and hashtags). */
  terms: string[];
  /** The song title and the artist name. */
  names: string[];
};

export type CopyViolation = {
  field: string;
  rule: 'run' | 'sentence' | 'phrase' | 'name';
  /** The copied words, lowercased. */
  quote: string;
  /** A sentence for the re-ask. */
  message: string;
};

const RUN_WORDS = 6;
const SENTENCE_WORDS = 3;
const PHRASE_WORDS = 3;

const words = (text: string) =>
  text
    .toLowerCase()
    .replaceAll('’', "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((word) => word.replaceAll(/^'+|'+$/g, ''))
    .filter(Boolean);

const sentences = (text: string) =>
  text
    .split(/[.!?]+/)
    .map(words)
    .filter((s) => s.length > 0);

/** Maximal runs of consecutive words that `a` and `b` share, as [start in a, length]. */
function sharedRuns(a: string[], b: string[]): [number, number][] {
  const runs: [number, number][] = [];
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (a[i] !== b[j] || (i > 0 && j > 0 && a[i - 1] === b[j - 1])) continue;
      let length = 1;
      while (a[i + length] !== undefined && a[i + length] === b[j + length]) length += 1;
      runs.push([i, length]);
    }
  }
  return runs;
}

/** Where `needle` first appears inside `haystack` as consecutive words, or -1. */
function indexOfRun(haystack: string[], needle: string[]): number {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((word, k) => haystack[i + k] === word)) return i;
  }
  return -1;
}

/**
 * Whether `run` is made only of whole terms from `exempt`, back to back. Words that merely appear
 * inside some term don't count.
 */
function wholeTerms(run: string[], exempt: string[][]): boolean {
  const reach = [true, ...run.map(() => false)];
  for (let at = 0; at < run.length; at++) {
    if (!reach[at]) continue;
    for (const term of exempt) {
      if (indexOfRun(run.slice(at, at + term.length), term) === 0) reach[at + term.length] = true;
    }
  }
  return reach[run.length]!;
}

const message = (rule: CopyViolation['rule'], field: string, quote: string) =>
  rule === 'name'
    ? `The ${field} names another artist's channel ("${quote}"). Remove it.`
    : `The ${field} copies another artist's wording ("${quote}"). Say it in your own words.`;

type Copied = [CopyViolation['rule'], string[]];

const as =
  (rule: CopyViolation['rule']) =>
  (run: string[]): Copied => [rule, run];

const namedPeers = (draft: string[], peers: PeerText[]) =>
  peers
    .map(({ channelTitle }) => words(channelTitle))
    .filter((title) => title.length > 0 && indexOfRun(draft, title) >= 0);

const copiedSentences = (draft: string[], peers: PeerText[]) =>
  peers
    .flatMap(({ texts }) => texts.flatMap(sentences))
    .filter((sentence) => sentence.length >= SENTENCE_WORDS && indexOfRun(draft, sentence) >= 0);

/**
 * Every place a draft field copies a peer, one violation per copied run:
 * 1. a run of 6+ words shared with one peer text
 * 2. a whole peer sentence of 3+ words
 * 3. a 3–5 word run shared with one peer text that holds a word found nowhere in the artist's own
 *    text, the analysis or the candidate lists
 * 4. a peer channel title
 *
 * A run made only of whole candidate terms, the song title or the artist name is exempt.
 */
export function checkCopy(fields: Record<string, string>, context: CopyContext): CopyViolation[] {
  const exempt = [...context.terms, ...context.names].map(words).filter((t) => t.length > 0);
  const known = new Set([...context.own, ...context.analysis, ...context.terms].flatMap(words));
  const peerTexts = context.peers.flatMap(({ texts }) => texts.map(words));
  const violations: CopyViolation[] = [];

  for (const [field, text] of Object.entries(fields)) {
    const draft = words(text);
    const shared = peerTexts.flatMap((peerWords) =>
      sharedRuns(draft, peerWords).map(([at, length]) => draft.slice(at, at + length)),
    );
    const isPhrase = (run: string[]) =>
      run.length >= PHRASE_WORDS && run.length < RUN_WORDS && run.some((w) => !known.has(w));
    // Order matters: a later, shorter run inside one already flagged is skipped.
    const copied = [
      ...namedPeers(draft, context.peers).map(as('name')),
      ...shared.filter((run) => run.length >= RUN_WORDS).map(as('run')),
      ...copiedSentences(draft, context.peers).map(as('sentence')),
      ...shared.filter(isPhrase).map(as('phrase')),
    ];
    const found: string[] = [];
    for (const [rule, run] of copied) {
      const quote = run.join(' ');
      // A longer copied run already says it.
      if (wholeTerms(run, exempt) || found.some((f) => ` ${f} `.includes(` ${quote} `))) continue;
      found.push(quote);
      violations.push({ field, rule, quote, message: message(rule, field, quote) });
    }
  }
  return violations;
}

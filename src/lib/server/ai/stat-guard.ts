// The model never writes a statistic (research R7): every sentence that states one is removed, so a
// number about reach only ever comes from YouTube as reported or from `research/calculated.ts`.
// Audio numbers are `numerics.ts`'s job; this file leaves them alone.

const NUMBER = String.raw`\d[\d,.]*(?:\s?[km]\b)?`;
const METRIC = String.raw`(?:views?|plays?|streams?|subscribers?|subs|followers?|fans?|likes?|comments?|shares?|watch[\s-]time|impressions?|ctr)\b`;
const SPELLED = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|dozens?)\b`;
const CHANGE = String.raw`(?:net|total|sum|average|gained|lost|rose|fell|grew|dropped|increased|decreased)\b`;
const MULTIPLIED = String.raw`(?:doubled|tripled|quadrupled|halved)\b`;
/** Up to three words between two terms. */
const NEAR = String.raw`(?:\W+\w+){0,3}?\W+`;

const STATISTIC = new RegExp(
  [
    String.raw`(?<![\w.,])${NUMBER}${NEAR}${METRIC}`,
    String.raw`\b${METRIC}${NEAR}${NUMBER}`,
    String.raw`\d\s?%|\bper\s?cent\b`,
    String.raw`\b${CHANGE}${NEAR}${NUMBER}`,
    String.raw`\b${SPELLED}${NEAR}${METRIC}`,
    String.raw`\b${METRIC}${NEAR}${SPELLED}`,
    String.raw`(?<![\w.])\d+(?:\.\d+)?x\b`,
    String.raw`\b(?:twice|thrice|(?:two|three|four|ten)\s+times)\s+as\s+(?:many|much)\b`,
    String.raw`\b${MULTIPLIED}${NEAR}${METRIC}`,
    String.raw`\b${METRIC}${NEAR}${MULTIPLIED}`,
  ].join('|'),
  'i',
);

export const NOT_STATED = 'Not stated.';

const isSpace = (char: string | undefined) => char === ' ' || char === '\t';

/** A line's sentences, each with its trailing space. Only a stop followed by a space ends one. */
function sentencesOf(line: string): string[] {
  const found: string[] = [];
  let start = 0;
  let stopped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (isSpace(char)) continue;
    if (stopped && isSpace(line[i - 1])) {
      found.push(line.slice(start, i));
      start = i;
    }
    stopped = char === '.' || char === '!' || char === '?';
  }
  return [...found, line.slice(start)];
}

/** Sentences (with their trailing space) and line breaks, in order; "4.5" stays in one sentence. */
const pieces = (text: string) => text.split(/(\n)/).flatMap(sentencesOf).filter(Boolean);

/**
 * `text` without the sentences that state a statistic, and whether any were removed. A field left
 * empty becomes `NOT_STATED`.
 */
export function stripStats(text: string): { text: string; removed: boolean } {
  let removed = false;
  const kept = pieces(text).filter((piece) => {
    const stat = piece !== '\n' && STATISTIC.test(piece);
    removed ||= stat;
    return !stat;
  });
  if (!removed) return { text, removed };
  const joined = kept
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
  return { text: joined || NOT_STATED, removed };
}

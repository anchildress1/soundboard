// Loudness, peak, level, tempo, and frequency figures. ffmpeg owns every audio number; the model's
// guesses at them are removed rather than shown next to the measured ones. The lookbehind stops a
// match from starting mid-number, which keeps the scan linear; `db[a-z]{0,2}` covers dB, dBA,
// dBFS, and dBTP.
const AUDIO_NUMBER = /(?<![\d.,])[-+−]?\d+(?:[.,]\d+)? ?(?:db[a-z]{0,2}|lufs|lkfs|lu|bpm|k?hz)\b/gi;

// Measurement talk often drops the unit ("12 clipped samples", "true peak -1", "loudness 9"), so
// counts and times are dropped from any sentence about clipping, silence, peak, loudness, or level.
// "clipp" skips "video clip"; the lookbehind leaves dates, versions, and URL paths alone.
const MEASURE_WORDS = /\b(?:clipp|silen|dropout|peak|loudness|headroom|gain|tempo|volume)/i;
const COUNT_OR_TIME = /(?<![\w.,:/])\d+(?:[.,:]\d+)? ?(?:ms|s|sec|seconds?|samples?)?\b/gi;
const LEADING_SIGN = /(?<=\s|^)[-+−](?=\d)/g;

const stripMeasuredCounts = (sentence: string) =>
  MEASURE_WORDS.test(sentence)
    ? sentence.replaceAll(LEADING_SIGN, '').replaceAll(COUNT_OR_TIME, '')
    : sentence;

/** Removes model-emitted audio-engineering numbers from one string. */
export function stripNumerics(text: string): string {
  return (
    text
      .replaceAll(AUDIO_NUMBER, '')
      // Sentence ends need trailing whitespace, so decimals like 7.5 stay whole.
      .split(/(?<=[.!?]\s|\n)/)
      .map(stripMeasuredCounts)
      .join('')
      .replaceAll('( )', '')
      .replaceAll('()', '')
      .replaceAll(/[ \t]{2,}/g, ' ')
      .replaceAll(/ ([,.;:)])/g, '$1')
      .trim()
  );
}

/** Applies `stripNumerics` to every string inside a JSON-shaped value. */
export function stripDeep<T>(value: T): T {
  if (typeof value === 'string') return stripNumerics(value) as T;
  if (Array.isArray(value)) {
    return value.map((item) => stripDeep(item)).filter((item) => item !== '') as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, stripDeep(item)]),
    ) as T;
  }
  return value;
}

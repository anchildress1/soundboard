// Loudness, peak, level, tempo, and frequency figures. ffmpeg owns every audio number; the model's
// guesses at them are removed rather than shown next to the measured ones.
const AUDIO_NUMBER = /[-+−]?\s?\d+(?:[.,]\d+)?\s?(?:dB(?:FS|TP|A)?|LUFS|LKFS|LU|bpm|BPM|k?Hz)\b/gi;

/** Removes model-emitted audio-engineering numbers from one string. */
export function stripNumerics(text: string): string {
  return text
    .replace(AUDIO_NUMBER, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
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

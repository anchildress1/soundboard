/** Shorts run up to 3 minutes, but the hook is what the Shorts feed plays; 15–60 s carries it. */
export const SHORT_MIN_SEC = 15;
export const SHORT_MAX_SEC = 60;

export const tenth = (n: number) => Math.round(n * 10) / 10;

/** The Short's length bounds for a source: 15–60 s, or the whole source when it runs shorter. */
export function lengthBounds(sourceSec: number): { min: number; max: number } {
  const max = tenth(Math.min(SHORT_MAX_SEC, sourceSec));
  return { min: Math.min(SHORT_MIN_SEC, max), max };
}

export type CutErrors = Partial<Record<'startSec' | 'lengthSec', string>>;

/** A cut must fit the length bounds and end inside the source. Values are seconds, to the tenth. */
export function cutErrors(
  cut: { startSec: number; lengthSec: number },
  sourceSec: number,
): CutErrors {
  const errors: CutErrors = {};
  const { min, max } = lengthBounds(sourceSec);
  if (!Number.isFinite(cut.lengthSec) || cut.lengthSec < min || cut.lengthSec > max) {
    errors.lengthSec = `Length must be ${min} to ${max} seconds.`;
    return errors;
  }
  const latest = tenth(sourceSec - cut.lengthSec);
  if (!Number.isFinite(cut.startSec) || cut.startSec < 0 || cut.startSec > latest) {
    errors.startSec = `Start must be 0 to ${latest} seconds for that length.`;
  }
  return errors;
}

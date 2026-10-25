const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** Pacific wall-clock time minus UTC at `at`, in ms. */
function pacificOffset(at: number): number {
  const part = Object.fromEntries(
    PACIFIC.formatToParts(at).map((p) => [p.type, Number(p.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  const wall = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
  return wall - Math.floor(at / 1000) * 1000;
}

/** The next midnight Pacific time, when YouTube's and Gemini's daily quotas reset. */
export function quotaResetAt(now: number): number {
  const today = new Date(now + pacificOffset(now));
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
  // US clocks change at 2 a.m., so the offset an hour either side of midnight is midnight's own.
  return midnight - pacificOffset(midnight - pacificOffset(now));
}

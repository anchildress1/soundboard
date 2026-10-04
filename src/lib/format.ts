/** `HH:MM:SS` for the monitor overlay. */
export function timecode(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Coarse relative age: `today`, `3d ago`, `5w ago`, `2y ago`. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return '';
  if (days < 1) return 'today';
  if (days < 14) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Vertical resolution label, e.g. `1080p`. */
/** "720p" from the short side, the way video is named; a taller-than-wide video is marked vertical. */
export function resolution(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  if (!height) return '';
  if (!width) return `${height}p`;
  return height > width ? `${width}p · vertical` : `${height}p`;
}

export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0;
}

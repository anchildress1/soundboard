/** Reads a required env var at call time, so tests and Cloud Run revisions see current values. */
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export function optional(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

export function modelUrl(): string {
  return optional('MODEL_URL', 'http://127.0.0.1:8081');
}

export function allowlist(): Set<string> {
  return new Set(
    optional('ALLOWLIST_EMAILS')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

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

const emailSet = (name: string) =>
  new Set(
    optional(name)
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );

/** Accounts with Nathan-level access: his memory, jobs, channel tokens, and the brand guide. */
export function allowlist(): Set<string> {
  return emailSet('ALLOWLIST_EMAILS');
}

/** Demo accounts: run like Nathan against the sandbox channel and never write his memory. */
export function demoEmails(): Set<string> {
  return emailSet('DEMO_EMAILS');
}

/** Reads a required env var at call time, so tests and Cloud Run revisions see current values. */
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export function optional(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

/** Gemini API authorization key; the only model credential. */
export function geminiApiKey(): string {
  return required('GEMINI_API_KEY');
}

/** Model for the chunk analyst, the one agent that must hear audio. */
export function analystModel(): string {
  return optional('GEMINI_ANALYST_MODEL', 'gemini-3.8-flash');
}

/** Model for smart pick, hook pick and the brand guide. */
export function pickModel(): string {
  return optional('GEMINI_PICK_MODEL', 'gemini-4-argon');
}

/** Who may sign in: invited emails only (the default), or any Google account. */
export function signupMode(): 'invite' | 'open' {
  const mode = optional('SIGNUP_MODE', 'invite');
  if (mode !== 'invite' && mode !== 'open') throw new Error(`Unknown SIGNUP_MODE ${mode}`);
  return mode;
}

/** Resource name of the Cloud KMS key that encrypts refresh tokens. */
export function kmsKey(): string {
  return required('KMS_KEY');
}

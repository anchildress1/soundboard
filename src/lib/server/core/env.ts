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

export type ResearchQueue = { queue: string; url: string; serviceAccount: string };

/**
 * The Cloud Tasks queue research deliveries go through, its target URL and the OIDC service
 * account; all three or none. None means deliveries run in-process (dev only).
 */
export function researchQueue(): ResearchQueue | null {
  const queue = optional('RESEARCH_QUEUE');
  const url = optional('RESEARCH_TASK_URL');
  const serviceAccount = optional('RESEARCH_TASK_SA');
  if (!queue && !url && !serviceAccount) return null;
  if (!queue || !url || !serviceAccount) {
    throw new Error('Set RESEARCH_QUEUE, RESEARCH_TASK_URL and RESEARCH_TASK_SA together');
  }
  return { queue, url, serviceAccount };
}

/** Whether peer-match hears a peer's public YouTube upload (gate G1); `'1'` or unset. */
export function peerHearing(): boolean {
  const value = optional('PEER_HEARING');
  if (value && value !== '1') throw new Error(`PEER_HEARING must be 1 or unset, not ${value}`);
  return value === '1';
}

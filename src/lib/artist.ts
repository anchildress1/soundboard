/** What the artist form sends: every field, with empty optional fields as `''`. */
export type ArtistInput = { name: string; bandcampUrl: string; contactLine: string };

/** A profile as stored: trimmed, the Bandcamp URL normalized, empty optional fields null. */
export type ArtistValue = { name: string; bandcampUrl: string | null; contactLine: string | null };

export type ArtistFieldErrors = Partial<Record<keyof ArtistInput, string>>;

export const NAME_MAX = 100;
export const CONTACT_MAX = 200;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.bandcamp\.com$/;
export const BANDCAMP_ERROR = 'Use your https://<name>.bandcamp.com address.';

// A comma would split the required tag in two, and a leading # reads as a hashtag (research R9).
function nameError(name: string): string | undefined {
  if (!name) return 'Add the artist name.';
  if (name.length > NAME_MAX) return `Artist names are at most ${NAME_MAX} characters.`;
  if (/[<>]/.test(name)) return "Artist names can't contain < or >.";
  if (name.includes(',')) return "Artist names can't contain commas.";
  if (name.startsWith('#')) return "Artist names can't start with #.";
  return undefined;
}

/** The normalized `https://<sub>.bandcamp.com` origin, or null when the URL isn't one. */
function bandcampOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const plain =
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash;
  return plain && SUBDOMAIN.test(url.hostname) ? `https://${url.hostname}` : null;
}

// The app appends the contact line verbatim, and a hashtag outside the job's list blocks approval.
function contactError(contact: string): string | undefined {
  if (contact.length > CONTACT_MAX) return `Contact lines are at most ${CONTACT_MAX} characters.`;
  if (/[<>]/.test(contact)) return "Contact lines can't contain < or >.";
  if (contact.includes('#')) return "Contact lines can't contain #.";
  return undefined;
}

const field = (body: Record<string, unknown>, key: keyof ArtistInput) =>
  typeof body[key] === 'string' ? body[key].trim() : '';

/** Validates the artist form; shared by the form and the server, which repeats it as CHECKs. */
export function parseArtist(
  input: unknown,
): { value: ArtistValue } | { errors: ArtistFieldErrors } {
  const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const name = field(body, 'name');
  const bandcamp = field(body, 'bandcampUrl');
  const contact = field(body, 'contactLine');
  const bandcampUrl = bandcamp ? bandcampOrigin(bandcamp) : null;
  const found: ArtistFieldErrors = {
    name: nameError(name),
    bandcampUrl: bandcamp && !bandcampUrl ? BANDCAMP_ERROR : undefined,
    contactLine: contactError(contact),
  };
  const errors = Object.fromEntries(
    Object.entries(found).filter(([, message]) => message !== undefined),
  ) as ArtistFieldErrors;
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { name, bandcampUrl, contactLine: contact || null } };
}

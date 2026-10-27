// Which sources a pick may cite for each role, and the slider text that asks for them (research R12).
import { ROLES, type Influence, type Level, type Role } from '#lib/influence.js';

/** The pick's own, non-peer sources. */
const OWN = ['analysis', 'voice', 'edits', 'identity'] as const;
const PEER = /^P\d+$/;
const RELEASE = /^P\d+-R\d+$/;
const GENRE = /^G\d+$/;

/** Refs the pick can cite, by kind; `G` and `P` refs are the ones this job has. */
export type Refs = { genre: string[]; peers: string[]; releases: string[]; outcomes: string[] };

/** Whether `ref` is a source `role` may cite, per R12's table. */
export function roleAllows(role: Role, ref: string, hasPeers: boolean): boolean {
  switch (role) {
    case 'sound':
      return ref === 'analysis' || PEER.test(ref);
    case 'feel':
    case 'wording':
      return ref === 'voice' || ref === 'edits' || PEER.test(ref) || RELEASE.test(ref);
    case 'discovery':
      return ref === 'analysis' || GENRE.test(ref) || RELEASE.test(ref);
    case 'structure':
      return ref === 'identity' || (!hasPeers && GENRE.test(ref)) || RELEASE.test(ref);
  }
}

/** Every ref this job has evidence for, own sources included. */
export const knownRefs = (refs: Refs): Set<string> =>
  new Set([...OWN, ...refs.genre, ...refs.peers, ...refs.releases]);

/** The reply's citations without unknown refs, refs a role may not cite, and duplicates. */
export function cleanCitations(raw: Record<Role, string[]>, refs: Refs): Record<Role, string[]> {
  const known = knownRefs(refs);
  const hasPeers = refs.peers.length > 0;
  return Object.fromEntries(
    ROLES.map((role) => [
      role,
      [...new Set(raw[role])].filter((ref) => known.has(ref) && roleAllows(role, ref, hasPeers)),
    ]),
  ) as Record<Role, string[]>;
}

/** Evidence a recommendation can rest on: any source the job has, the artist's results included. */
export const cleanEvidence = (raw: string[], refs: Refs): string[] => {
  const known = knownRefs(refs);
  return [...new Set(raw)].filter((ref) => known.has(ref) || refs.outcomes.includes(ref));
};

const SOURCES: Record<Role, string> = {
  sound: 'own: analysis; peers: P<n>',
  feel: 'own: voice, edits; peers: P<n>, P<n>-R<m>',
  wording: 'own: voice, edits; peers: P<n>, P<n>-R<m>',
  discovery: 'own: G<n>, analysis; peers: P<n>-R<m>',
  structure: 'own: identity (G<n> only when there are no peers); peers: P<n>-R<m>',
};

const LEVEL_RULES: Record<Level, string> = {
  0: 'cite no similar artist; follow only the artist’s own sources',
  1: 'mostly the artist’s own sources, with one similar artist’s source as a light influence',
  2: 'blend the artist’s own sources with similar artists’ sources about evenly',
  3: 'lean on similar artists’ sources, with one of the artist’s own as an anchor',
  4: 'follow similar artists’ sources most strongly',
};

/**
 * The slider settings as prompt rules. Level 4 for feel and wording asks for two different
 * artists' sources, so the draft blends voices instead of echoing one.
 */
export function influenceRules(influence: Influence): string {
  return ROLES.map((role) => {
    const level = influence[role];
    const two =
      level === 4 && (role === 'feel' || role === 'wording')
        ? ' Cite sources from at least two different similar artists.'
        : '';
    return `- ${role} (level ${level} of 4): ${LEVEL_RULES[level]}. Citable: ${SOURCES[role]}.${two}`;
  }).join('\n');
}

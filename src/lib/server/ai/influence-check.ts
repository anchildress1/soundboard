// Checks a pick's citations against the artist's slider levels (research R12, FR-024).
import { ROLES, type Influence, type Level, type Role } from '#lib/influence.js';
import { peerOf } from '#lib/server/research/brackets.js';

/** The `P<n>` and `P<n>-R<m>` refs the job has evidence for. */
export type PeerRefs = { peers: string[]; releases: string[] };

export type Mismatch = { role: Role; level: Level; problem: string };

export type InfluenceCheck = {
  /** Roles whose citations don't meet their level, each with a sentence for the re-ask. */
  failing: Mismatch[];
  /** Server-built limits for roles whose level needs evidence the job doesn't have. */
  limits: string[];
};

/** Which evidence a role may cite (the peer half of R12's table). */
const SOURCES: Record<Role, (refs: PeerRefs) => string[]> = {
  sound: ({ peers }) => peers,
  feel: ({ peers, releases }) => [...peers, ...releases],
  wording: ({ peers, releases }) => [...peers, ...releases],
  discovery: ({ releases }) => releases,
  structure: ({ releases }) => releases,
};

/** Feel and wording at the top level need more than one voice to blend, not a single peer's. */
const NEEDS_TWO = new Set<Role>(['feel', 'wording']);

const isPeerRef = (ref: string) => /^P\d+(-R\d+)?$/.test(ref);

function problem(role: Role, level: Level, peerCited: number, need: number) {
  if (level === 0) return `Set ${role} to the artist's own sources only: cite no similar artist.`;
  if (peerCited === 0) return `Cite at least one similar artist's source for ${role}.`;
  if (peerCited < need)
    return `Cite sources from at least ${need} different similar artists for ${role}.`;
  return `Also cite one of the artist's own sources for ${role}.`;
}

/** How many different peers `role` must cite at `level`; fewer available than two is a limit. */
function peersNeeded(role: Role, level: Level, have: string[], limits: string[]): number {
  if (level === 0) return 0;
  if (level < 4 || !NEEDS_TWO.has(role)) return 1;
  const distinct = new Set(have.map((ref) => peerOf(ref))).size;
  if (distinct < 2) limits.push(`Only one similar artist was available for ${role}.`);
  return Math.min(2, distinct);
}

/**
 * Level 0 cites no peer. Levels 1–3 cite at least one peer and one non-peer. Level 4 cites at least
 * one peer, and feel and wording cite two different peers. Evidence a level needs but the job lacks
 * is a limit, never a mismatch.
 */
export function checkInfluence(
  citations: Record<Role, string[]>,
  influence: Influence,
  available: PeerRefs,
): InfluenceCheck {
  const failing: Mismatch[] = [];
  const limits: string[] = [];
  for (const role of ROLES) {
    const level = influence[role];
    const cited = citations[role];
    const peerRefs = cited.filter(isPeerRef);
    const have = SOURCES[role](available);
    if (level > 0 && have.length === 0) {
      limits.push(
        `No similar-artist evidence was available for ${role}, so its setting didn't apply.`,
      );
      continue;
    }
    const peerCited = new Set(peerRefs.map((ref) => peerOf(ref))).size;
    const ownCited = cited.length - peerRefs.length;
    const need = peersNeeded(role, level, have, limits);
    const ok =
      level === 0 ? peerRefs.length === 0 : peerCited >= need && (level === 4 || ownCited > 0);
    if (!ok) failing.push({ role, level, problem: problem(role, level, peerCited, need) });
  }
  return { failing, limits };
}

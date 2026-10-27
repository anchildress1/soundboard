import { describe, expect, it } from 'vitest';
import { ROLES, type Influence, type Level, type Role } from '#lib/influence.js';
import { checkInfluence, type PeerRefs } from '#lib/server/ai/influence-check.js';

const refs: PeerRefs = { peers: ['P1', 'P2', 'P3'], releases: ['P1-R1', 'P2-R1', 'P3-R1'] };
const none: Record<Role, string[]> = {
  sound: [],
  feel: [],
  wording: [],
  discovery: [],
  structure: [],
};
const all = (level: Level): Influence => ({
  sound: level,
  feel: level,
  wording: level,
  discovery: level,
  structure: level,
});
const at0 = all(0);

/** A peer ref each role may cite, and a non-peer one. */
const PEER: Record<Role, string> = {
  sound: 'P1',
  feel: 'P1',
  wording: 'P1',
  discovery: 'P1-R1',
  structure: 'P1-R1',
};
const OWN: Record<Role, string> = {
  sound: 'analysis',
  feel: 'voice',
  wording: 'edits',
  discovery: 'G1',
  structure: 'identity',
};

describe('checkInfluence', () => {
  describe.each(ROLES)('%s', (role) => {
    const cite = (...list: string[]) => ({ ...none, [role]: list });
    const at = (level: Level): Influence => ({ ...at0, [role]: level });

    it('level 0 passes with only the artist’s own sources, and fails any peer ref', () => {
      expect(checkInfluence(cite(OWN[role]), at(0), refs).failing).toEqual([]);
      expect(checkInfluence(cite(), at(0), refs).failing).toEqual([]);
      const failed = checkInfluence(cite(OWN[role], PEER[role]), at(0), refs).failing;
      expect(failed).toMatchObject([{ role, level: 0 }]);
      expect(failed[0]!.problem).toContain(role);
    });

    it.each([1, 2, 3] as const)('level %i needs a peer ref and a non-peer ref', (level) => {
      expect(checkInfluence(cite(PEER[role], OWN[role]), at(level), refs).failing).toEqual([]);
      expect(checkInfluence(cite(OWN[role]), at(level), refs).failing).toMatchObject([{ role }]);
      const noOwn = checkInfluence(cite(PEER[role]), at(level), refs).failing;
      expect(noOwn).toMatchObject([{ role, level }]);
      expect(noOwn[0]!.problem).toContain('own sources');
    });

    it('level 4 needs a peer ref', () => {
      const peers = ['wording', 'feel'].includes(role) ? ['P1', 'P2'] : [PEER[role]];
      expect(checkInfluence(cite(...peers), at(4), refs).failing).toEqual([]);
      expect(checkInfluence(cite(OWN[role]), at(4), refs).failing).toMatchObject([{ role }]);
    });
  });

  it('fails wording at 4 when both refs come from one peer', () => {
    const result = checkInfluence(
      { ...none, wording: ['P1', 'P1-R1'] },
      { ...all(0), wording: 4 },
      refs,
    );
    expect(result.failing).toMatchObject([{ role: 'wording', level: 4 }]);
    expect(result.failing[0]!.problem).toContain('2 different');
    expect(result.limits).toEqual([]);
  });

  it('passes feel at 4 with refs from two peers, mixing peers and releases', () => {
    const result = checkInfluence({ ...none, feel: ['P1', 'P2-R1'] }, { ...all(0), feel: 4 }, refs);
    expect(result.failing).toEqual([]);
  });

  it('asks only for one peer at 4 when the job has just one, and says so as a limit', () => {
    const one: PeerRefs = { peers: ['P1'], releases: ['P1-R1'] };
    const result = checkInfluence({ ...none, wording: ['P1'] }, { ...all(0), wording: 4 }, one);
    expect(result.failing).toEqual([]);
    expect(result.limits).toEqual(['Only one similar artist was available for wording.']);
    expect(checkInfluence(none, { ...all(0), wording: 4 }, one).failing).toMatchObject([
      { role: 'wording' },
    ]);
  });

  it('turns missing evidence into a limit, not a mismatch', () => {
    const result = checkInfluence(none, all(4), { peers: [], releases: [] });
    expect(result.failing).toEqual([]);
    expect(result.limits).toHaveLength(5);
    expect(result.limits[0]).toContain('sound');
  });

  it('judges each role against the evidence it may cite', () => {
    // Peers but no releases: discovery and structure have nothing to cite.
    const result = checkInfluence(
      { ...none, sound: ['P1'] },
      { ...all(0), sound: 4, discovery: 4, structure: 4 },
      { peers: ['P1'], releases: [] },
    );
    expect(result.failing).toEqual([]);
    expect(result.limits).toEqual([
      "No similar-artist evidence was available for discovery, so its setting didn't apply.",
      "No similar-artist evidence was available for structure, so its setting didn't apply.",
    ]);
  });

  it('still fails a peer ref at level 0 when there is no evidence', () => {
    const result = checkInfluence({ ...none, sound: ['P1'] }, all(0), { peers: [], releases: [] });
    expect(result.failing).toMatchObject([{ role: 'sound', level: 0 }]);
  });

  it('passes the defaults with the matching citations', () => {
    const citations: Record<Role, string[]> = {
      sound: ['analysis', 'P1'],
      feel: ['voice'],
      wording: ['edits'],
      discovery: ['P1-R1'],
      structure: ['P2-R1'],
    };
    const defaults: Influence = { sound: 1, feel: 0, wording: 0, discovery: 4, structure: 4 };
    expect(checkInfluence(citations, defaults, refs)).toEqual({ failing: [], limits: [] });
  });
});

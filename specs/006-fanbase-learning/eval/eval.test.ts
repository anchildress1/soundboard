// @vitest-environment node
// Fixed-evidence evaluation E1 (quickstart E1, research R15). Live Gemini calls: run it by hand,
// with GEMINI_API_KEY set and the ledger read first. It writes eval/result.json.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkInfluence } from '#lib/server/ai/influence-check.js';
import { CopiedWording, refsOf, runPick, type FinalPick } from '#lib/server/ai/smart-pick.js';
import { stepDeadline } from '#lib/server/ai/model.js';
import { stripStats } from '#lib/server/ai/stat-guard.js';
import { context, SCENARIOS } from './fixture';

// gemini-4-argon: $2 per million input tokens, $14 per million output tokens (thinking included).
const cost = (input: number, output: number) => (input * 2 + output * 14) / 1_000_000;

type Usage = { input: number; output: number };
const usage: Usage = { input: 0, output: 0 };
const replies: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  const response = await realFetch(...args);
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    usage?: {
      total_input_tokens?: number;
      total_output_tokens?: number;
      total_thought_tokens?: number;
    };
    steps?: { type: string; content?: { text?: string }[] }[];
  } | null;
  usage.input += body?.usage?.total_input_tokens ?? 0;
  usage.output +=
    (body?.usage?.total_output_tokens ?? 0) + (body?.usage?.total_thought_tokens ?? 0);
  const text = body?.steps?.find((s) => s.type === 'model_output')?.content?.[0]?.text;
  if (text) replies.push(text);
  return response;
}) as typeof fetch;

type Raw = {
  title: string;
  description: string;
  brandCheck: string;
  why: Record<string, string>;
  bandcamp: { about: string; credits: string };
  recommendation: { approach: string; intendedOutcome: string; followsWhy: string };
};

const results: unknown[] = [];

describe('fixed-evidence evaluation', () => {
  it.each(SCENARIOS.map((scenario, index) => [index + 1, scenario] as const))(
    'pick %i',
    async (number, scenario) => {
      const before = { ...usage };
      const calls = replies.length;
      const ctx = context(scenario);
      let pick: FinalPick | null = null;
      let failure: string | null = null;
      try {
        pick = (await runPick(ctx, stepDeadline()))?.pick ?? null;
      } catch (error) {
        failure =
          error instanceof CopiedWording ? 'copy check failed after the re-ask' : String(error);
      }
      const made = replies.slice(calls);
      const raw = made.length > 0 ? (JSON.parse(made.at(-1)!) as Raw) : null;
      // The model wrote no statistic if the guard finds nothing to remove in its own words.
      const stripped = raw
        ? [
            raw.title,
            raw.description,
            raw.brandCheck,
            ...Object.values(raw.why),
            raw.bandcamp.about,
            raw.bandcamp.credits,
            raw.recommendation.approach,
            raw.recommendation.intendedOutcome,
            raw.recommendation.followsWhy,
          ].some((text) => stripStats(text).removed)
        : null;
      const refs = refsOf(ctx);
      const influence = pick
        ? checkInfluence(pick.citations!, ctx.influence, {
            peers: refs.peers,
            releases: refs.releases,
          })
        : null;
      const advice = pick?.recommendation ?? null;
      const spent = cost(usage.input - before.input, usage.output - before.output);
      results.push({
        pick: number,
        scenario: scenario.name,
        providerCalls: made.length,
        failure,
        draft: pick && {
          title: pick.title,
          description: pick.description,
          tags: pick.tags,
          hashtags: pick.hashtags,
          bandcampAbout: pick.bandcamp.about,
        },
        citations: pick?.citations,
        recommendation: advice,
        influenceWarning: pick?.influenceWarning,
        influenceFailures: influence?.failing ?? null,
        limits: pick?.limits,
        modelWroteAStatistic: stripped,
        costUsd: Number(spent.toFixed(4)),
      });
      writeFileSync(
        new URL('./result.json', import.meta.url),
        JSON.stringify({ model: 'gemini-4-argon', results }, null, 2),
      );
      expect(failure).toBeNull();
      expect(pick).not.toBeNull();
      expect(influence!.failing).toEqual([]);
      expect(stripped).toBe(false);
      if (number === 1) expect(pick!.limits).toContain('analytics-not-shared');
      if (number === 2) {
        expect(advice?.followsWhy ?? '').toMatch(/\bA\d+\b/);
        expect(advice?.followsWhy ?? '').toMatch(/\bP\d+/);
      }
      if (number === 3) expect(advice?.followsWhy ?? '').not.toMatch(/\bcaus/i);
    },
  );
});

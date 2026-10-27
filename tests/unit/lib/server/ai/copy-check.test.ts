import { describe, expect, it } from 'vitest';
import { checkCopy, type CopyContext } from '#lib/server/ai/copy-check.js';

const context = (over: Partial<CopyContext> = {}): CopyContext => ({
  peers: [
    {
      channelTitle: 'Nova Drift',
      texts: [
        'Born in the static. Neon rain falls on empty highways tonight.',
        'Midnight engines hum beneath a cracked chrome moon',
      ],
    },
  ],
  own: ['I write short plain lines about night drives and old synths'],
  analysis: ['Slow dark synthwave with a steady pulse'],
  terms: ['dark synthwave', 'retro', '#nightdrive'],
  names: ['Argon', 'Flies Like Robots'],
  ...over,
});

const quotes = (fields: Record<string, string>, over?: Partial<CopyContext>) =>
  checkCopy(fields, context(over)).map((v) => [v.rule, v.quote]);

describe('checkCopy rule 1: a long shared run', () => {
  it('fails a run of 6 words from one peer text', () => {
    const found = quotes({ description: 'Neon rain falls on empty highways, always.' });
    expect(found).toContainEqual(['run', 'neon rain falls on empty highways']);
  });

  it('does not fail a 5-word run by this rule when each word is known', () => {
    const found = quotes(
      { description: 'neon rain falls on empty' },
      { own: ['neon rain falls on empty'] },
    );
    expect(found).toEqual([]);
  });

  it('ignores case and punctuation', () => {
    const found = quotes({
      description: 'MIDNIGHT engines, hum -- beneath a cracked: chrome moon!',
    });
    expect(found).toContainEqual(['run', 'midnight engines hum beneath a cracked chrome moon']);
  });

  it('does not join words across two peer texts', () => {
    const found = quotes(
      { description: 'highways tonight midnight engines hum beneath' },
      { own: ['highways tonight midnight engines hum beneath'] },
    );
    expect(found).toEqual([]);
  });

  it('reports a longer run once, not again as shorter pieces', () => {
    const found = quotes({ description: 'neon rain falls on empty highways tonight' });
    expect(found).toHaveLength(1);
    expect(found[0]![0]).toBe('run');
  });
});

describe('checkCopy rule 2: a whole peer sentence', () => {
  it('fails a copied sentence of 4 words', () => {
    const found = quotes({ description: 'A new single. Born in the static, out now.' });
    expect(found).toContainEqual(['sentence', 'born in the static']);
  });

  it('allows a sentence of 2 words', () => {
    const found = quotes(
      { description: 'out now' },
      { peers: [{ channelTitle: 'Nova Drift', texts: ['Out now.'] }] },
    );
    expect(found).toEqual([]);
  });

  it('splits on exclamation and question marks too', () => {
    const found = quotes(
      { description: 'Are you ready tonight' },
      { peers: [{ channelTitle: 'Nova Drift', texts: ['Ready? Are you ready tonight! Go.'] }] },
    );
    expect(found).toContainEqual(['sentence', 'are you ready tonight']);
  });
});

describe('checkCopy rule 3: a distinctive phrase', () => {
  it('fails 3 shared words when one appears nowhere in the artist text, analysis or terms', () => {
    const found = quotes({ description: 'Under a cracked chrome sky' });
    expect(found).toContainEqual(['phrase', 'a cracked chrome']);
  });

  it('passes the same 3 words when each is in the artist text', () => {
    const found = quotes(
      { description: 'Under a cracked chrome sky' },
      { own: ['a cracked chrome'] },
    );
    expect(found).toEqual([]);
  });

  it('passes words found only in the analysis or the candidate terms', () => {
    const found = quotes(
      { description: 'a cracked chrome' },
      { analysis: ['a cracked'], terms: ['chrome'] },
    );
    expect(found).toEqual([]);
  });

  it('does not fail a 2-word overlap', () => {
    expect(quotes({ description: 'cracked chrome' })).toEqual([]);
  });

  it('fails the phrase against a release description as well as a channel description', () => {
    const found = quotes(
      { title: 'beneath a cracked' },
      {
        peers: [
          {
            channelTitle: 'Nova Drift',
            texts: ['x', 'Midnight engines hum beneath a cracked chrome moon'],
          },
        ],
      },
    );
    expect(found).toContainEqual(['phrase', 'beneath a cracked']);
  });
});

describe('checkCopy rule 4: a peer name', () => {
  it('fails a peer channel title in the Bandcamp copy', () => {
    const found = quotes({ bandcampAbout: 'Fans of Nova Drift will like it.' });
    expect(found).toEqual([['name', 'nova drift']]);
  });

  it('matches whole words only', () => {
    const found = quotes(
      { description: 'a novadrifting thing' },
      { peers: [{ channelTitle: 'Nova', texts: [] }] },
    );
    expect(found).toEqual([]);
  });

  it('ignores a peer with an empty title', () => {
    expect(
      quotes({ description: 'anything' }, { peers: [{ channelTitle: '', texts: [] }] }),
    ).toEqual([]);
  });

  it('fails a peer channel title even when a candidate list carries it as a term', () => {
    const found = quotes(
      { description: 'Fans of Nova Drift will like this.' },
      { terms: ['nova drift', 'retro'] },
    );
    expect(found).toEqual([['name', 'nova drift']]);
  });

  it('allows the artist name even when a peer shares it', () => {
    const found = quotes(
      { description: 'flies like robots' },
      { peers: [{ channelTitle: 'Flies Like Robots', texts: [] }] },
    );
    expect(found).toEqual([]);
  });
});

describe('checkCopy exemptions', () => {
  it('passes a run made of whole candidate terms', () => {
    const found = quotes(
      { description: 'dark synthwave retro dark synthwave retro' },
      { peers: [{ channelTitle: 'X', texts: ['dark synthwave retro dark synthwave retro'] }] },
    );
    expect(found).toEqual([]);
  });

  it('passes the song title and the artist name', () => {
    const found = quotes(
      { description: 'argon flies like robots' },
      { peers: [{ channelTitle: 'X', texts: ['Argon. Flies like robots'] }] },
    );
    expect(found).toEqual([]);
  });

  it('matches hashtag terms as words', () => {
    const found = quotes(
      { description: 'nightdrive retro nightdrive' },
      { peers: [{ channelTitle: 'X', texts: ['nightdrive retro nightdrive'] }] },
    );
    expect(found).toEqual([]);
  });

  it('fails a 6-word peer sentence whose words each sit inside candidate terms but not as whole terms', () => {
    const found = quotes(
      { description: 'retro night drive dark future synthwave' },
      {
        peers: [{ channelTitle: 'X', texts: ['Retro night drive dark future synthwave.'] }],
        terms: ['dark synthwave', 'night retro', 'drive future', 'retro'],
      },
    );
    expect(found).toContainEqual(['run', 'retro night drive dark future synthwave']);
  });

  it('fails a run that is only partly terms', () => {
    const found = quotes(
      { description: 'retro dark synthwave glows over cracked chrome' },
      { peers: [{ channelTitle: 'X', texts: ['retro dark synthwave glows over cracked chrome'] }] },
    );
    expect(found.map(([rule]) => rule)).toContain('run');
  });
});

describe('checkCopy reporting', () => {
  it('names the field and the copied words in a sentence for the re-ask', () => {
    const [violation] = checkCopy({ why: 'Born in the static' }, context());
    expect(violation).toMatchObject({
      field: 'why',
      rule: 'sentence',
      quote: 'born in the static',
    });
    expect(violation!.message).toContain('The why copies');
    expect(violation!.message).toContain('"born in the static"');
  });

  it('words a name violation as a channel name', () => {
    const [violation] = checkCopy({ description: 'like Nova Drift' }, context());
    expect(violation!.message).toBe(
      `The description names another artist's channel ("nova drift"). Remove it.`,
    );
  });

  it('checks every field and reports each', () => {
    const found = checkCopy({ title: 'nova drift', description: 'born in the static' }, context());
    expect(found.map((v) => v.field)).toEqual(['title', 'description']);
  });

  it('returns nothing for a clean draft, with no peers or no fields', () => {
    expect(quotes({ description: 'Slow night drive music with warm synths' })).toEqual([]);
    expect(quotes({ description: 'born in the static' }, { peers: [] })).toEqual([]);
    expect(checkCopy({}, context())).toEqual([]);
  });

  it('treats typographic apostrophes like plain ones', () => {
    const found = quotes(
      { description: 'don’t stop the night drive tonight' },
      { peers: [{ channelTitle: 'X', texts: ["Don't stop the night drive tonight"] }], own: [] },
    );
    expect(found.length).toBeGreaterThan(0);
  });
});

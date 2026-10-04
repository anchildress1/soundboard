import { describe, expect, it } from 'vitest';
import { heardTags, jobStatus, lastModelSeconds } from '$lib/status';
import type { Chunk, ChunkAnalysis, JobState, JobView, Pick, PublicJob } from '$lib/types';

const job = (patch: Partial<PublicJob> = {}): PublicJob => ({
  id: 'j1',
  state: 'ANALYZE',
  owner: 'visitor',
  channel: null,
  songTitle: 'PeekaBoo',
  notes: '',
  filename: 'peekaboo.mp4',
  sampleId: null,
  probe: null,
  measurements: null,
  chunkCount: 4,
  chunkIndex: 1,
  failedState: null,
  error: null,
  uploadProgress: null,
  videoId: null,
  payload: null,
  hashtagCandidates: null,
  createdAt: 0,
  ...patch,
});

const view = (patch: Partial<PublicJob> = {}, extra: Partial<JobView> = {}): JobView => ({
  job: job(patch),
  chunks: [],
  pick: null,
  ...extra,
});

const music = (m: Partial<ChunkAnalysis['music']>): ChunkAnalysis => ({
  visual: '',
  music: { genre: [], tempoFeel: '', instrumentation: [], vocals: '', mood: [], ...m },
  qualityFlags: [],
});

const chunk = (index: number, analysis: ChunkAnalysis | null, modelMs = 1000): Chunk => ({
  index,
  startSec: index * 29.5,
  durationSec: 29.5,
  measurements: {
    integratedLufs: -14,
    truePeakDbtp: -1,
    peakLevelDb: -1,
    clippedSamples: 0,
    silences: [],
  },
  analysis,
  raw: analysis ? null : '{bad',
  modelMs,
});

describe('jobStatus', () => {
  it('shows a named wait with running progress ahead of the state label', () => {
    expect(jobStatus(view({ state: 'ANALYZE' }), 'waking model')).toEqual({
      tone: 'info',
      text: 'waking model',
      progress: 6 + 21,
    });
  });

  it('shows upload percent while awaiting the browser upload', () => {
    expect(jobStatus(view({ state: 'AWAITING_UPLOAD' }), undefined, 42)).toEqual({
      tone: 'info',
      text: 'Uploading 42%',
      progress: 42,
    });
    expect(jobStatus(view({ state: 'AWAITING_UPLOAD' })).text).toBe('Uploading 0%');
  });

  it('shows chunk N / M during analysis, clamped to the count', () => {
    expect(jobStatus(view({ state: 'ANALYZE', chunkIndex: 0, chunkCount: 4 }))).toEqual({
      tone: 'info',
      text: 'Chunk 1 / 4',
      progress: 6,
    });
    expect(jobStatus(view({ state: 'ANALYZE', chunkIndex: 4, chunkCount: 4 }))).toEqual({
      tone: 'info',
      text: 'Chunk 4 / 4',
      progress: 90,
    });
  });

  it('uses a floor progress before chunks are counted', () => {
    expect(jobStatus(view({ state: 'ANALYZE', chunkIndex: 0, chunkCount: 0 })).progress).toBe(4);
    expect(jobStatus(view({ chunkCount: 0 }), 'waiting on YouTube').progress).toBe(4);
  });

  it('reports YouTube upload progress while publishing', () => {
    expect(
      jobStatus(view({ state: 'PUBLISHING', uploadProgress: { sent: 50, total: 200 } })),
    ).toEqual({ tone: 'info', text: 'Uploading to YouTube 25%', progress: 25 });
    expect(jobStatus(view({ state: 'PUBLISHING' }))).toEqual({
      tone: 'info',
      text: 'Uploading to YouTube 0%',
      progress: 0,
    });
    expect(
      jobStatus(view({ state: 'PUBLISHING', uploadProgress: { sent: 0, total: 0 } })).progress,
    ).toBe(0);
  });

  it('only calls a job verified after read-back', () => {
    expect(jobStatus(view({ state: 'CLAIMED_COMPLETE' }))).toEqual({
      tone: 'info',
      text: 'Verifying upload',
      progress: 100,
    });
    expect(jobStatus(view({ state: 'VERIFIED' }))).toEqual({
      tone: 'ok',
      text: 'Verified · private',
      progress: 100,
    });
  });

  it('labels the remaining states', () => {
    const expected: [JobState, string, string, number][] = [
      ['PREP', 'info', 'Measuring audio', 4],
      ['PICK', 'info', 'Smart pick', 92],
      ['REVIEW', 'warn', 'Needs review', 100],
      ['PAYLOAD', 'warn', 'Payload ready', 100],
      ['FAILED', 'err', 'Failed', 6 + 21],
      ['DISCARDED', 'err', 'Discarded', 0],
    ];
    for (const [state, tone, text, progress] of expected) {
      expect(jobStatus(view({ state }))).toEqual({ tone, text, progress });
    }
  });
});

describe('heardTags', () => {
  it('ranks genre, tempo feel, and instrumentation by frequency, case-folded', () => {
    const v = view(
      {},
      {
        chunks: [
          chunk(
            0,
            music({
              genre: ['Synthwave', 'indie'],
              tempoFeel: 'driving',
              instrumentation: ['synth bass'],
              vocals: 'male lead',
            }),
          ),
          chunk(
            1,
            music({
              genre: ['synthwave'],
              tempoFeel: 'Driving',
              instrumentation: ['synth bass', 'drum machine'],
              vocals: '',
            }),
          ),
          chunk(
            2,
            music({
              genre: [' synthwave '],
              tempoFeel: 'driving',
              instrumentation: [],
              vocals: 'male lead',
            }),
          ),
        ],
      },
    );
    const tags = heardTags(v);
    expect(tags.slice(0, 2)).toEqual(['synthwave', 'driving']);
    expect(tags).toEqual(expect.arrayContaining(['synth bass', 'indie', 'drum machine']));
    expect(tags).toHaveLength(5);
  });

  it('ignores mood and quality flags, blanks, and chunks without analysis', () => {
    const v = view(
      {},
      {
        chunks: [
          chunk(0, null),
          chunk(1, { ...music({ genre: ['  '], mood: ['dreamy'] }), qualityFlags: ['dropout'] }),
        ],
      },
    );
    expect(heardTags(v)).toEqual([]);
  });

  it('never shows the vocals description, including "none"', () => {
    const v = view(
      {},
      {
        chunks: [
          chunk(0, music({ genre: ['glitch'], vocals: 'None' })),
          chunk(1, music({ vocals: 'none' })),
        ],
      },
    );
    expect(heardTags(v)).not.toContain('none');
  });

  it('honours the limit', () => {
    const v = view({}, { chunks: [chunk(0, music({ genre: ['a', 'b', 'c', 'd'] }))] });
    expect(heardTags(v, 2)).toEqual(['a', 'b']);
    expect(heardTags(v, 0)).toEqual([]);
  });
});

describe('lastModelSeconds', () => {
  const pick: Pick = {
    version: 1,
    title: 't',
    description: '',
    hashtags: [],
    tags: [],
    flags: [],
    brandCheck: '',
    why: { title: '', description: '', tags: '' },
    bandcamp: { about: 'Bandcamp about.', credits: 'Written by Nathan.' },
    modelMs: 12_400,
  };

  it('prefers the pick over the last chunk', () => {
    expect(lastModelSeconds(view({}, { pick, chunks: [chunk(0, null, 3000)] }))).toBe(12);
  });

  it('falls back to the last chunk', () => {
    expect(
      lastModelSeconds(view({}, { chunks: [chunk(0, null, 3000), chunk(1, null, 7600)] })),
    ).toBe(8);
  });

  it('is null with no model call or a zero duration', () => {
    expect(lastModelSeconds(view())).toBeNull();
    expect(lastModelSeconds(view({}, { chunks: [chunk(0, null, 0)] }))).toBeNull();
  });
});

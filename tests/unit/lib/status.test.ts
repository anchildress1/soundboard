import { describe, expect, it } from 'vitest';
import {
  heardTags,
  jobStatus,
  savedPercent,
  UPLOAD_NOTICE,
  type UploadShown,
  modelLabel,
  modelRole,
  modelSeconds,
  modelWorking,
  publishPaused,
} from '#lib/status.js';
import type { Chunk, ChunkAnalysis, JobState, JobView, Pick, PublicJob } from '#lib/types.js';

const BUSY = 'model busy';
const SYNTH_BASS = 'synth bass';

const job = (patch: Partial<PublicJob> = {}): PublicJob => ({
  id: 'j1',
  state: 'ANALYZE',
  parentId: null,
  destination: null,
  songTitle: 'PeekaBoo',
  notes: '',
  filename: 'peekaboo.mp4',
  probe: null,
  measurements: null,
  chunkCount: 4,
  chunkIndex: 1,
  failedState: null,
  error: null,
  uploadProgress: null,
  videoId: null,
  finalFields: null,
  hashtagCandidates: null,
  shortId: null,
  short: null,
  createdAt: 0,
  ...patch,
});

const view = (patch: Partial<PublicJob> = {}, extra: Partial<JobView> = {}): JobView => ({
  job: job(patch),
  chunks: [],
  pick: null,
  model: 'gemini-4-argon',
  ...extra,
});

const music = (m: Partial<ChunkAnalysis['music']>): ChunkAnalysis => ({
  visual: '',
  music: { genre: [], tempoFeel: '', instrumentation: [], vocals: '', mood: [], ...m },
  qualityFlags: [],
});

const chunk = (index: number, analysis: ChunkAnalysis | null, modelMs = 1000): Chunk => ({
  index,
  analysis,
  modelMs,
  startSec: index * 29.5,
  durationSec: 29.5,
  measurements: {
    integratedLufs: -14,
    truePeakDbtp: -1,
    peakLevelDb: -1,
    clippedSamples: 0,
    silences: [],
  },
  raw: analysis ? null : '{bad',
});

describe('publishPaused', () => {
  it.each(['PUBLISHING', 'CLAIMED_COMPLETE'] as const)(
    'allows owner action in paused %s',
    (state) => {
      for (const wait of [
        'reconnect YouTube',
        'upload outcome unknown',
        'Daily upload limit reached. Try tomorrow.',
      ] as const) {
        expect(publishPaused(view({ state }, { wait }))).toBe(true);
      }
      expect(publishPaused(view({ state }))).toBe(false);
      expect(publishPaused(view({ state }, { wait: 'step running in another tab' }))).toBe(false);
    },
  );

  it.each(['REVIEW', 'FAILED', 'VERIFIED', 'DISCARDED'] as const)(
    'ignores stale publishing waits in %s',
    (state) => {
      expect(publishPaused(view({ state }, { wait: 'upload outcome unknown' }))).toBe(false);
    },
  );
});

describe('jobStatus', () => {
  it.each([
    [BUSY, 'Model busy'],
    ['model quota spent', 'Model quota spent'],
    ['Add your artist name first.', 'Add your artist name first.'],
  ] as const)(
    'shows the %s wait in plain words with running progress ahead of the state label',
    (wait, text) => {
      expect(jobStatus(view({ state: 'ANALYZE' }), wait)).toEqual({
        tone: 'info',
        text,
        progress: 6 + 21,
      });
    },
  );

  describe('browser upload', () => {
    const uploading = (upload: UploadShown) =>
      jobStatus(view({ state: 'AWAITING_UPLOAD' }), undefined, upload);

    it('shows the confirmed percent, rounded down, while sending', () => {
      expect(uploading({ state: 'sending', saved: 42, total: 100 })).toEqual({
        tone: 'info',
        text: 'Uploading 42%',
        progress: 42,
      });
      expect(uploading({ state: 'sending', saved: 999, total: 1000 }).text).toBe('Uploading 99%');
      expect(uploading({ state: 'sending', saved: 1000, total: 1000 }).text).toBe('Uploading 100%');
      expect(jobStatus(view({ state: 'AWAITING_UPLOAD' })).text).toBe('Uploading 0%');
    });

    it.each([
      ['offline', 'Upload paused: no connection'],
      ['stall', 'Upload paused: no connection'],
      ['no-reply', 'Upload paused: no connection'],
      ['timeout', 'Upload paused: no connection'],
      ['408', 'Upload paused: no connection'],
      ['429', 'Upload paused: storage busy, retrying'],
      ['5xx', 'Upload paused: storage busy, retrying'],
    ] as const)('names a %s pause at the confirmed amount', (reason, text) => {
      expect(uploading({ state: 'paused', reason, saved: 30, total: 120 })).toEqual({
        tone: 'warn',
        text,
        progress: 25,
      });
    });

    it('asks for the file with the saved percent, or without one when it is unknown', () => {
      expect(uploading({ state: 'pick', saved: 0, total: 10 }).text).toBe(
        'Upload paused at 0%. Pick the video to continue.',
      );
      expect(uploading({ state: 'pick', saved: 5, total: 10 })).toEqual({
        tone: 'warn',
        text: 'Upload paused at 50%. Pick the video to continue.',
        progress: 50,
      });
      expect(uploading({ state: 'pick', saved: 9, total: 10 }).text).toBe(
        'Upload paused at 90%. Pick the video to continue.',
      );
      expect(uploading({ state: 'pick', saved: null, total: 10 })).toEqual({
        tone: 'warn',
        text: 'Pick the video to continue.',
        progress: 0,
      });
    });

    it('says the upload paused while away, at the saved percent', () => {
      expect(uploading({ state: 'away', saved: 3, total: 4 })).toEqual({
        tone: 'warn',
        text: 'The upload paused while you were away.',
        progress: 75,
      });
    });

    it.each([
      ['unreadable', 'err', "Couldn't read this video. Pick it again."],
      ['other-tab', 'info', 'Uploading in another tab'],
      ['replaced', 'warn', 'A different video replaced this upload.'],
      ['moved', 'warn', 'The upload moved to another device or window.'],
      ['discarded', 'err', 'This job was discarded.'],
    ] as const)('shows the %s state', (state, tone, text) => {
      expect(uploading({ state })).toEqual({ tone, text, progress: 0 });
    });

    it('reads 0% for an empty total', () => {
      expect(savedPercent(0, 0)).toBe(0);
    });

    it('keeps the two start-over notices verbatim', () => {
      expect(UPLOAD_NOTICE).toEqual({
        'new-video': 'New video: starting the upload over.',
        renewed: 'The saved upload expired; starting again.',
      });
    });
  });

  it('shows chunk N / M during analysis, clamped to the count', () => {
    expect(jobStatus(view({ state: 'ANALYZE', chunkIndex: 0, chunkCount: 4 }))).toEqual({
      tone: 'info',
      text: 'Window 1 of 4',
      progress: 6,
    });
    expect(jobStatus(view({ state: 'ANALYZE', chunkIndex: 4, chunkCount: 4 }))).toEqual({
      tone: 'info',
      text: 'Window 4 of 4',
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
      ['HOOK', 'info', 'Picking the hook', 30],
      ['RENDER', 'info', 'Cutting the Short', 60],
      ['REVIEW', 'warn', 'Needs review', 100],
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
              instrumentation: [SYNTH_BASS],
              vocals: 'male lead',
            }),
          ),
          chunk(
            1,
            music({
              genre: ['synthwave'],
              tempoFeel: 'Driving',
              instrumentation: [SYNTH_BASS, 'drum machine'],
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
    expect(tags).toEqual(expect.arrayContaining([SYNTH_BASS, 'indie', 'drum machine']));
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

describe('modelSeconds', () => {
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
    artistName: null,
    modelMs: 12_400,
  };

  it('adds the pick to every chunk', () => {
    expect(modelSeconds(view({}, { pick, chunks: [chunk(0, null, 3000)] }))).toBe(15);
  });

  it('sums the chunks before the pick exists', () => {
    expect(modelSeconds(view({}, { chunks: [chunk(0, null, 3000), chunk(1, null, 7600)] }))).toBe(
      11,
    );
  });

  it('keeps earlier pick runs and adds the running call during a re-run', () => {
    const picking = view({ state: 'PICK' }, { pick, chunks: [chunk(0, null, 3000)] });
    expect(modelSeconds(picking)).toBe(15);
    expect(modelSeconds(picking, 2400)).toBe(18);
  });

  it('counts a pick with no chunks loaded', () => {
    expect(modelSeconds(view({}, { pick }))).toBe(12);
  });

  it("uses a Short's hook pick, not the video pick it copied", () => {
    const short = {
      parentId: 'p',
      sourceDurationSec: 180,
      reframe: 'blur' as const,
      hook: null,
      skipped: [],
      renders: 0,
      modelMs: 4_600,
    };
    expect(modelSeconds(view({ short }, { pick }))).toBe(5);
    expect(modelSeconds(view({ short: { ...short, modelMs: 0 } }, { pick }))).toBeNull();
    expect(modelSeconds(view({ short }, { pick }), 1400)).toBe(6);
  });

  it('is null with no model call or a zero duration', () => {
    expect(modelSeconds(view())).toBeNull();
    expect(modelSeconds(view({}, { chunks: [chunk(0, null, 0)] }))).toBeNull();
  });
});

describe('modelWorking', () => {
  it('is true while the pick runs', () => {
    expect(modelWorking(view({ state: 'PICK' }))).toBe(true);
  });

  it('is false while the model waits, during chunks, or outside model states', () => {
    expect(modelWorking(view({ state: 'PICK' }, { wait: BUSY }))).toBe(false);
    expect(modelWorking(view({ state: 'PICK' }, { wait: 'model quota spent' }))).toBe(false);
    expect(modelWorking(view({ state: 'ANALYZE' }))).toBe(false);
    expect(modelWorking(view({ state: 'PREP' }))).toBe(false);
    expect(modelWorking(view({ state: 'REVIEW' }))).toBe(false);
  });
});

describe('modelRole', () => {
  it.each([
    ['AWAITING_UPLOAD', 'picker'],
    ['PREP', 'analyst'],
    ['ANALYZE', 'analyst'],
    ['PICK', 'picker'],
    ['REVIEW', 'picker'],
    ['VERIFIED', 'picker'],
  ] as const)('uses the %s role from the state', (state, role) => {
    expect(modelRole(job({ state }))).toBe(role);
  });

  it('takes a failed job role from the step it failed at', () => {
    expect(modelRole(job({ state: 'FAILED', failedState: 'ANALYZE' }))).toBe('analyst');
    expect(modelRole(job({ state: 'FAILED', failedState: 'PICK' }))).toBe('picker');
    expect(modelRole(job({ state: 'FAILED', failedState: null }))).toBe('analyst');
  });

  it('always uses the picker for a Short', () => {
    const short = { modelMs: 0 } as PublicJob['short'];
    expect(modelRole(job({ state: 'RENDER', short }))).toBe('picker');
    expect(modelRole(job({ state: 'FAILED', failedState: 'PREP', short }))).toBe('picker');
  });
});

describe('modelLabel', () => {
  it('names the configured model and its role', () => {
    expect(modelLabel(view({ state: 'ANALYZE' }, { model: 'gemini-3.8-flash' }))).toBe(
      'Configured analyst: gemini-3.8-flash',
    );
    expect(modelLabel(view({ state: 'REVIEW' }))).toBe('Configured picker: gemini-4-argon');
  });
});

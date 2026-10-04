import { describe, expect, it } from 'vitest';
import { setPending, takePending, type PendingUpload } from '$lib/pending';

const upload = (name: string): PendingUpload => ({
  file: new File(['x'], name, { type: 'video/mp4' }),
  uploadUrl: `https://storage.example/${name}?sig=1`,
  objectUrl: `blob:${name}`,
  contentType: 'video/mp4',
});

describe('pending uploads', () => {
  it('hands a stored upload to its job once', () => {
    const u = upload('a.mp4');
    setPending('job-a', u);
    expect(takePending('job-a')).toBe(u);
    expect(takePending('job-a')).toBeUndefined();
  });

  it('returns undefined for a job with nothing pending', () => {
    expect(takePending('never-set')).toBeUndefined();
  });

  it('keeps jobs separate and lets a later set replace an earlier one', () => {
    const first = upload('1.mp4');
    const second = upload('2.mp4');
    const other = upload('3.mp4');
    setPending('job-b', first);
    setPending('job-b', second);
    setPending('job-c', other);
    expect(takePending('job-b')).toBe(second);
    expect(takePending('job-c')).toBe(other);
  });
});

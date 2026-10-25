// @vitest-environment node
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cutWindowClip, MAX_CLIP_BYTES, measureWindow } from '#lib/server/media/window.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const spawnMock = vi.mocked(spawn);

const URL_ = 'https://storage.example/obj?X-Goog-Signature=secret';
const NOW = 1_000_000;

type Fake = { bytes?: number; code?: number; stderr?: string; abort?: boolean };
/** Writes `bytes` to the output path (the last argument) before exiting, as ffmpeg would. */
function nextRun(fake: Fake) {
  spawnMock.mockImplementationOnce(((_cmd: string, args: string[]) => {
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 7, stdout: new EventEmitter(), stderr });
    setImmediate(() => {
      if (fake.bytes !== undefined) writeFileSync(args.at(-1)!, Buffer.alloc(fake.bytes));
      if (fake.abort) child.emit('error', new DOMException('timed out', 'AbortError'));
      if (fake.stderr) stderr.emit('data', Buffer.from(fake.stderr));
      setImmediate(() => child.emit('close', fake.abort ? null : (fake.code ?? 0)));
    });
    return child;
  }) as unknown as typeof spawn);
}

const outPath = () => spawnMock.mock.calls[0]![1]!.at(-1)!;

let timeout: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  spawnMock.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  timeout = vi.spyOn(AbortSignal, 'timeout');
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [, args] of spawnMock.mock.calls) rmSync(args!.at(-1)!, { force: true });
});

describe('cutWindowClip', () => {
  it('returns a unique temp MP4 holding the window, for the caller to read and delete', async () => {
    nextRun({ bytes: 1234 });
    nextRun({ bytes: 1234 });
    const path = await cutWindowClip(URL_, 60, 120, NOW + 110_000);
    const other = await cutWindowClip(URL_, 60, 120, NOW + 110_000);
    expect(dirname(path)).toBe(tmpdir());
    expect(path).toMatch(/\.mp4$/);
    expect(path).not.toBe(other);
    expect(statSync(path).size).toBe(1234);
    const args = spawnMock.mock.calls[0]![1]!;
    expect(args[args.indexOf('-ss') + 1]).toBe('60.000');
    expect(args[args.indexOf('-t') + 1]).toBe('60.000');
    expect(args).toContain(URL_);
  });

  it('accepts a clip of exactly the byte limit', async () => {
    nextRun({ bytes: MAX_CLIP_BYTES });
    const path = await cutWindowClip(URL_, 0, 60, NOW + 110_000);
    expect(statSync(path).size).toBe(8_000_000);
  });

  it('rejects one byte over the limit and deletes the file', async () => {
    nextRun({ bytes: MAX_CLIP_BYTES + 1 });
    await expect(cutWindowClip(URL_, 0, 60, NOW + 110_000)).rejects.toThrow(
      'The window clip is 8000001 bytes, over the 8000000-byte limit.',
    );
    expect(existsSync(outPath())).toBe(false);
  });

  it('fails on empty or missing output', async () => {
    nextRun({ bytes: 0 });
    await expect(cutWindowClip(URL_, 0, 60, NOW + 110_000)).rejects.toThrow('came out empty');
    expect(existsSync(outPath())).toBe(false);
    nextRun({});
    await expect(cutWindowClip(URL_, 0, 60, NOW + 110_000)).rejects.toThrow('ENOENT');
  });

  it('deletes partial output when ffmpeg fails', async () => {
    nextRun({ bytes: 500, code: 1, stderr: 'Invalid data found' });
    await expect(cutWindowClip(URL_, 0, 60, NOW + 110_000)).rejects.toThrow(
      'ffmpeg exited 1: Invalid data found',
    );
    expect(existsSync(outPath())).toBe(false);
  });

  it('on a timeout, waits for ffmpeg to exit, then deletes its file', async () => {
    nextRun({ bytes: 500, abort: true });
    await expect(cutWindowClip(URL_, 0, 60, NOW + 110_000)).rejects.toThrow('timed out');
    expect(existsSync(outPath())).toBe(false);
  });

  it('caps the cut at 45 s, or at the time the step has left', async () => {
    nextRun({ bytes: 1 });
    nextRun({ bytes: 1 });
    await cutWindowClip(URL_, 0, 60, NOW + 110_000);
    await cutWindowClip(URL_, 0, 60, NOW + 12_000);
    expect(timeout.mock.calls).toEqual([[45_000], [12_000]]);
  });

  it('starts nothing once the deadline has passed', async () => {
    await expect(cutWindowClip(URL_, 0, 60, NOW)).rejects.toThrow('ran out of time');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('measureWindow', () => {
  it('measures the window in file time, capped at 20 s or the time left', async () => {
    nextRun({ stderr: 'silence_start: 50\n' });
    nextRun({});
    expect((await measureWindow(URL_, 60, 120, NOW + 110_000)).silences).toEqual([
      { start: 110, end: 120 },
    ]);
    await measureWindow(URL_, 60, 90.5, NOW + 5_000);
    expect(timeout.mock.calls).toEqual([[20_000], [5_000]]);
    const args = spawnMock.mock.calls[1]![1]!;
    expect(args[args.indexOf('-t') + 1]).toBe('30.500');
  });

  it('starts nothing once the deadline has passed', async () => {
    await expect(measureWindow(URL_, 0, 60, NOW - 1)).rejects.toThrow('ran out of time');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

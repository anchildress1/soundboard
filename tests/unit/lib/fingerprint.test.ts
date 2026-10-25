import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprint } from '#lib/fingerprint.js';

const KIB = 1024;
const MIB = KIB * KIB;
const MODIFIED = 1_760_000_000_000;

function bytes(size: number, seed = 7): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const file = (data: Uint8Array<ArrayBuffer>, name = 'peekaboo.mp4', lastModified = MODIFIED) =>
  new File([data], name, { lastModified, type: 'video/mp4' });

/** The documented input, built independently with Node's hash. */
function expected(data: Uint8Array, name: string, lastModified: number): string {
  const hash = createHash('sha256');
  const head = Buffer.alloc(8);
  head.writeBigUInt64BE(BigInt(data.length));
  const encoded = Buffer.from(name, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  const modified = Buffer.alloc(8);
  modified.writeBigUInt64BE(BigInt(lastModified));
  hash.update(head).update(length).update(encoded).update(modified);
  hash.update(data.subarray(0, MIB)).update(data.subarray(Math.max(0, data.length - MIB)));
  for (let i = 0; i < 64; i++) {
    const start = Math.max(0, Math.floor((i * (data.length - 64 * KIB)) / 63));
    hash.update(data.subarray(start, start + 64 * KIB));
  }
  return hash.digest('hex');
}

describe('fingerprint', () => {
  it.each([100 * KIB, 10 * MIB, 10])(
    'hashes exactly the documented bytes of a %i-byte file',
    async (size) => {
      const data = bytes(size);
      expect(await fingerprint(file(data))).toBe(expected(data, 'peekaboo.mp4', MODIFIED));
    },
  );

  it('is 64 lowercase hex characters', async () => {
    expect(await fingerprint(file(bytes(KIB)))).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['inside a sample', Math.floor((32 * (10 * MIB - 64 * KIB)) / 63) + 5],
    ['in the first MiB', 10],
    ['in the last MiB', 10 * MIB - 10],
  ])('changes when a byte %s changes', async (_where, at) => {
    const data = bytes(10 * MIB);
    const changed = data.slice();
    changed[at] = changed[at]! ^ 0xff;
    expect(await fingerprint(file(changed))).not.toBe(await fingerprint(file(data)));
  });

  it('changes with the size, name or last-modified time', async () => {
    const data = bytes(MIB);
    const base = await fingerprint(file(data));
    expect(await fingerprint(file(bytes(MIB + 1)))).not.toBe(base);
    expect(await fingerprint(file(data, 'other.mp4'))).not.toBe(base);
    expect(await fingerprint(file(data, 'peekaboo.mp4', MODIFIED + 1))).not.toBe(base);
  });

  it('documents the accepted limit (spec FR-009, SC-004): a change only between samples is the same file', async () => {
    const size = 20 * MIB;
    const data = bytes(size);
    const changed = data.slice();
    // Sample 31 ends before sample 32 starts; this byte is in neither, nor in either end MiB.
    const gap = Math.floor((31 * (size - 64 * KIB)) / 63) + 64 * KIB + 100;
    changed[gap] = changed[gap]! ^ 0xff;
    expect(await fingerprint(file(changed))).toBe(await fingerprint(file(data)));
  });

  it('rejects when the file can’t be read', async () => {
    const blob = globalThis.Blob;
    // A Blob over an unreadable part fails its read the same way the browser's does.
    class FailingBlob extends blob {
      override arrayBuffer() {
        return Promise.reject(new DOMException('gone', 'NotReadableError'));
      }
    }
    globalThis.Blob = FailingBlob;
    try {
      await expect(fingerprint(file(bytes(KIB)))).rejects.toThrow('gone');
    } finally {
      globalThis.Blob = blob;
    }
  });
});

const MIB = 1024 * 1024;
const SAMPLE = 64 * 1024;
const SAMPLES = 64;

/** The parts of `file` the fingerprint hashes, in order: about 6 MiB at most. */
function sampled(file: File): BlobPart[] {
  const name = new TextEncoder().encode(file.name);
  const head = new DataView(new ArrayBuffer(8 + 4 + name.length + 8));
  head.setBigUint64(0, BigInt(file.size));
  head.setUint32(8, name.length);
  new Uint8Array(head.buffer).set(name, 12);
  head.setBigUint64(12 + name.length, BigInt(file.lastModified));
  const parts: BlobPart[] = [
    head.buffer,
    file.slice(0, MIB),
    file.slice(Math.max(0, file.size - MIB)),
  ];
  for (let i = 0; i < SAMPLES; i++) {
    // Blob.slice counts a negative start from the end, so small files clamp to 0 explicitly.
    const start = Math.max(0, Math.floor((i * (file.size - SAMPLE)) / (SAMPLES - 1)));
    parts.push(file.slice(start, start + SAMPLE));
  }
  return parts;
}

/**
 * Hex SHA-256 over the file's size, name, last-modified time, first and last MiB, and 64 evenly
 * spread 64 KiB samples. A file that differs only between samples reads as the same file: the
 * accepted cost of not hashing up to 2 GB before every resume.
 */
export async function fingerprint(file: File): Promise<string> {
  const bytes = await new Blob(sampled(file)).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

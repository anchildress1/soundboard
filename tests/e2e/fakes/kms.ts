// Stands in for @google-cloud/kms in the E2E build (vite.config.ts, E2E_FAKES=1). Reversible, not
// secret: the "ciphertext" is the plaintext behind a marker, so fixtures can seed it directly.
const MARKER = Buffer.from('e2e-kms:');

type Bytes = Uint8Array | string | null | undefined;

const bytes = (value: Bytes) => Buffer.from(value ?? '');

export class KeyManagementServiceClient {
  async encrypt({ plaintext }: { name: string; plaintext: Bytes }) {
    return [{ ciphertext: Buffer.concat([MARKER, bytes(plaintext)]) }] as const;
  }

  async decrypt({ ciphertext }: { name: string; ciphertext: Bytes }) {
    const sealed = bytes(ciphertext);
    // Real KMS rejects foreign ciphertext with gRPC INVALID_ARGUMENT and this `details` text.
    if (!sealed.subarray(0, MARKER.length).equals(MARKER)) {
      const details = 'Decryption failed: the ciphertext is invalid.';
      throw Object.assign(new Error(`3 INVALID_ARGUMENT: ${details}`), { code: 3, details });
    }
    return [{ plaintext: sealed.subarray(MARKER.length) }] as const;
  }
}
